/* ce-gemdosfs: present an Atari partition (or a whole image) so Linux can use
   it, as one file "part" in a FUSE mount:

   --bpb   GEMDOS partitions with logical sectors over 4 KB ("BGM" partitions
           of AHDI/HDDRIVER): Linux's FAT driver refuses sectors over 4 KB,
           but every size in the boot sector counts logical sectors, so the
           same layout described in 512-byte sectors is the same file system.
           The boot sector the kernel reads is that rewritten one; nothing
           else changes, and the real boot sector is never written (writes to
           the first 512 bytes stay in memory).
           The same for GEMDOS partitions with under 4085 clusters, whatever
           their sector size: TOS uses FAT16 on every hard disk partition,
           Linux goes by the cluster count and would read these as FAT12.
           Linux gets a file system of 4085 clusters instead: the boot sector
           says so, each FAT is as long as that needs, and the clusters that
           aren't there are marked bad in it, so they are never used (the
           free space is the real one). Root folder and data follow the
           longer FATs; on the disk nothing moves.
   --swap  a byte-swapped image (some IDE/Falcon images made by emulators):
           every 16-bit word swapped back on the fly, both ways.
   --rw    writable (without it: read-only).

     ce-gemdosfs [--bpb] [--swap] [--rw] <source> <offset> <length> <mountpoint>
     ce-gemdosfs [--bpb] [--swap] --cat <source> <offset> <length>    the file to stdout (tests)
     ce-gemdosfs [--bpb] [--swap] --rw --apply <file> <source> <offset> <length>   the file (a changed --cat dump) written through (tests)
     ce-gemdosfs [--swap] --probe <source> <offset>                   bps= spc= clusters= few= rootfill= ok= why=

   ce-hdinspect mounts the translated file through a loop device with the
   kernel's own FAT driver. Refused (--probe ok=no): not a GEMDOS boot sector,
   clusters over 64 KB (the FAT driver's limit), and with --rw a root
   folder that doesn't fill whole logical sectors (Linux could put entries in
   the padding, which TOS never reads). */

#define FUSE_USE_VERSION 31
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#ifndef NO_FUSE
#include <fuse.h>
#endif

static int srcFd = -1;
static off_t base = 0, length = 0;
static int doSwap = 0, doBpb = 0, writable = 0;
static unsigned char vboot[512];
static int haveVboot = 0;
/* under 4085 clusters (see above): where the FATs are, how long each is on
   the disk and for Linux, how many of a FAT's bytes are real entries, and
   where the real data ends; all in bytes */
static int few = 0;
static off_t fatOff = 0, fatLen = 0, vFatLen = 0, fatReal = 0, realEnd = 0, vLength = 0;
static int nFat = 0;
#define FEW_CLUSTERS 4085UL

/* ---------------------------------------------------------------- source */

static void swap16(unsigned char *b, size_t n)
{
    for(size_t i = 0; i + 1 < n; i += 2) { unsigned char t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; }
}

/* bytes of the partition (pos from its start), swapped back if --swap */
static ssize_t readSrc(void *buf, size_t n, off_t pos)
{
    off_t abs = base + pos;
    if(!doSwap) {
        size_t got = 0;
        while(got < n) {
            ssize_t r = pread(srcFd, (char *) buf + got, n - got, abs + got);
            if(r < 0) { if(errno == EINTR) continue; return -errno; }
            if(r == 0) break;
            got += r;
        }
        return got;
    }
    off_t a = abs & ~(off_t) 1, e = (abs + n + 1) & ~(off_t) 1;
    unsigned char *t = malloc(e - a);
    if(!t) return -ENOMEM;
    size_t got = 0;
    while(got < (size_t) (e - a)) {
        ssize_t r = pread(srcFd, t + got, (e - a) - got, a + got);
        if(r < 0) { if(errno == EINTR) continue; free(t); return -errno; }
        if(r == 0) break;
        got += r;
    }
    if(got & 1) t[got++] = 0;
    swap16(t, got);
    size_t from = abs - a, have = got > from ? got - from : 0;
    if(have > n) have = n;
    memcpy(buf, t + from, have);
    free(t);
    return have;
}

static ssize_t writeSrc(const void *buf, size_t n, off_t pos)
{
    off_t abs = base + pos;
    if(!doSwap) {
        size_t done = 0;
        while(done < n) {
            ssize_t r = pwrite(srcFd, (const char *) buf + done, n - done, abs + done);
            if(r < 0) { if(errno == EINTR) continue; return -errno; }
            done += r;
        }
        return n;
    }
    off_t a = abs & ~(off_t) 1, e = (abs + n + 1) & ~(off_t) 1;
    unsigned char *t = malloc(e - a);
    if(!t) return -ENOMEM;
    if(a != abs || e != abs + (off_t) n) {                  /* an odd edge: keep the other byte */
        if(pread(srcFd, t, e - a, a) < 0) { free(t); return -errno; }
        swap16(t, e - a);
    }
    memcpy(t + (abs - a), buf, n);
    swap16(t, e - a);
    ssize_t r = pwrite(srcFd, t, e - a, a);
    free(t);
    return r < 0 ? -errno : (ssize_t) n;
}

/* ------------------------------------------------------------ boot sector */

static unsigned le16(const unsigned char *p) { return p[0] | (p[1] << 8); }
static unsigned long le32(const unsigned char *p) { return p[0] | (p[1] << 8) | ((unsigned long) p[2] << 16) | ((unsigned long) p[3] << 24); }
static void put16(unsigned char *p, unsigned v) { p[0] = v; p[1] = v >> 8; }
static void put32(unsigned char *p, unsigned long v) { put16(p, v & 0xffff); put16(p + 2, v >> 16); }
static int pow2(unsigned v) { return v && !(v & (v - 1)); }

struct geo { unsigned bps, spc, res, nfat, rootent, spf, vspf; unsigned long tot, vtot, clusters; int rootfill, few; };

/* the GEMDOS boot sector's layout; 0 and why when it isn't one we can use */
static int readGeo(const unsigned char *b, struct geo *g, const char **why)
{
    g->bps = le16(b + 11); g->spc = b[13]; g->res = le16(b + 14); g->nfat = b[16];
    g->rootent = le16(b + 17); g->spf = le16(b + 22);
    g->tot = le16(b + 19) ? le16(b + 19) : le32(b + 32);
    if(!pow2(g->bps) || g->bps < 512 || g->bps > 32768) { *why = "not a GEMDOS boot sector (sector size)"; return 0; }
    if(!pow2(g->spc) || g->spc > 128) { *why = "not a GEMDOS boot sector (cluster size)"; return 0; }
    if(g->nfat < 1 || g->nfat > 2 || !g->res || !g->spf || !g->rootent || !g->tot) { *why = "not a GEMDOS boot sector"; return 0; }
    unsigned long rootSecs = ((unsigned long) g->rootent * 32 + g->bps - 1) / g->bps;
    unsigned long meta = g->res + (unsigned long) g->nfat * g->spf + rootSecs;
    if(g->tot <= meta) { *why = "not a GEMDOS boot sector (sizes)"; return 0; }
    g->clusters = (g->tot - meta) / g->spc;
    g->rootfill = ((unsigned long) g->rootent * 32) % g->bps == 0;
    unsigned k = g->bps / 512;
    if((unsigned long) g->spc * k > 128) { *why = "clusters over 64 KB (beyond Linux's FAT driver)"; return 0; }
    if(g->clusters >= 65525) { *why = "too many clusters for FAT16"; return 0; }
    /* what Linux is shown: the same, or with under 4085 clusters a file system of 4085 */
    g->few = g->clusters < FEW_CLUSTERS;
    g->vspf = g->spf; g->vtot = g->tot;
    if(g->few) {
        unsigned need = ((FEW_CLUSTERS + 2) * 2 + g->bps - 1) / g->bps;
        if(need > g->vspf) g->vspf = need;
        g->vtot = g->res + (unsigned long) g->nfat * g->vspf + rootSecs + FEW_CLUSTERS * g->spc;
    }
    if((unsigned long) g->vspf * k > 65535) { *why = "the FAT is too big for 512-byte sectors"; return 0; }
    return 1;
}

/* the same file system described in 512-byte sectors */
static void translate(unsigned char *b, const struct geo *g)
{
    unsigned k = g->bps / 512;
    unsigned long rootSecsLogical = ((unsigned long) g->rootent * 32 + g->bps - 1) / g->bps;
    unsigned rootent = rootSecsLogical * g->bps / 32;         /* the root folder fills its sectors */
    unsigned long tot = g->vtot * k;
    put16(b + 11, 512);
    b[13] = g->spc * k;
    put16(b + 14, g->res * k);
    put16(b + 17, rootent);
    put16(b + 22, g->vspf * k);
    if(tot <= 65535) { put16(b + 19, tot); put32(b + 32, 0); }
    else { put16(b + 19, 0); put32(b + 32, tot); }
    put32(b + 28, 0);                                           /* hidden sectors */
    if(b[21] < 0xf0 || (b[21] > 0xf0 && b[21] < 0xf8)) b[21] = 0xf8;    /* media byte the driver accepts */
}

/* -------------------------------------------------------------- the file */

/* One piece of the file as Linux sees it, from off: where it is on the disk
   (*real) and how long it runs (the return value, at most size). *real is -1
   for what isn't on the disk: the FATs' entries of the clusters that aren't
   there (bad cluster marks) and the room of those clusters (zeros). Without
   "few" the file is the partition as it is. */
static size_t piece(off_t off, size_t size, off_t *real)
{
    off_t end;
    if(!few) { *real = off; end = length; }
    else if(off < fatOff) { *real = off; end = fatOff; }
    else if(off < fatOff + nFat * vFatLen) {
        off_t rel = (off - fatOff) % vFatLen, copy = (off - fatOff) / vFatLen;
        if(rel < fatReal) { *real = fatOff + copy * fatLen + rel; end = off + (fatReal - rel); }
        else { *real = -1; end = off + (vFatLen - rel); }
    } else {
        off_t r = off - nFat * (vFatLen - fatLen);
        if(r < realEnd) { *real = r; end = off + (realEnd - r); }
        else { *real = -1; end = vLength; }
    }
    if(off >= end) return 0;
    return (off_t) size < end - off ? size : (size_t) (end - off);
}

static ssize_t vread(char *buf, size_t size, off_t off)
{
    size_t done = 0;
    while(done < size) {
        off_t real, at = off + done;
        size_t n = piece(at, size - done, &real);
        if(n == 0) break;
        if(real >= 0) {
            ssize_t r = readSrc(buf + done, n, real);
            if(r < 0) return r;
            if((size_t) r < n) memset(buf + done + r, 0, n - r);      /* an image cut short */
        } else if(at < fatOff + nFat * vFatLen) {
            for(size_t q = 0; q < n; q++) buf[done + q] = ((at + q - fatOff) % vFatLen) & 1 ? 0xff : 0xf7;     /* 0xFFF7: a bad cluster */
        } else {
            memset(buf + done, 0, n);
        }
        done += n;
    }
    if(haveVboot && off < 512 && done) {
        size_t room = (size_t) (512 - off), n = room < done ? room : done;
        memcpy(buf, vboot + off, n);
    }
    return done;
}

static ssize_t vwrite(const char *buf, size_t size, off_t off)
{
    if(!writable) return -EROFS;
    size_t done = 0;
    while(done < size) {
        off_t real, at = off + done;
        size_t n = piece(at, size - done, &real);
        if(n == 0) return done ? (ssize_t) done : -ENOSPC;
        size_t skip = 0;
        if(haveVboot && at < 512) {                  /* the rewritten boot sector: kept in memory only */
            size_t room = (size_t) (512 - at);
            skip = room < n ? room : n;
            memcpy(vboot + at, buf + done, skip);
        }
        if(real >= 0 && skip < n) {                  /* (what isn't on the disk: nothing to write) */
            ssize_t r = writeSrc(buf + done + skip, n - skip, real + skip);
            if(r < 0) return r;
        }
        done += n;
    }
    return done;
}

#ifndef NO_FUSE
static int fsGetattr(const char *path, struct stat *st, struct fuse_file_info *fi)
{
    (void) fi;
    memset(st, 0, sizeof(*st));
    if(strcmp(path, "/") == 0) { st->st_mode = S_IFDIR | 0755; st->st_nlink = 2; return 0; }
    if(strcmp(path, "/part") == 0) { st->st_mode = S_IFREG | (writable ? 0600 : 0400); st->st_nlink = 1; st->st_size = few ? vLength : length; return 0; }
    return -ENOENT;
}

static int fsReaddir(const char *path, void *buf, fuse_fill_dir_t fill, off_t off, struct fuse_file_info *fi, enum fuse_readdir_flags fl)
{
    (void) off; (void) fi; (void) fl;
    if(strcmp(path, "/") != 0) return -ENOENT;
    fill(buf, ".", NULL, 0, 0);
    fill(buf, "..", NULL, 0, 0);
    fill(buf, "part", NULL, 0, 0);
    return 0;
}

static int fsOpen(const char *path, struct fuse_file_info *fi)
{
    if(strcmp(path, "/part") != 0) return -ENOENT;
    if((fi->flags & O_ACCMODE) != O_RDONLY && !writable) return -EROFS;
    fi->direct_io = 1;                                  /* no second cache under the loop device */
    return 0;
}

static int fsRead(const char *path, char *buf, size_t size, off_t off, struct fuse_file_info *fi)
{
    (void) path; (void) fi;
    return vread(buf, size, off);
}

static int fsWrite(const char *path, const char *buf, size_t size, off_t off, struct fuse_file_info *fi)
{
    (void) path; (void) fi;
    return vwrite(buf, size, off);
}

static int fsFsync(const char *path, int datasync, struct fuse_file_info *fi)
{
    (void) path; (void) fi;
    return (datasync ? fdatasync(srcFd) : fsync(srcFd)) < 0 ? -errno : 0;
}

static int fsFlush(const char *path, struct fuse_file_info *fi)
{
    (void) path; (void) fi;
    return writable && fsync(srcFd) < 0 ? -errno : 0;
}

static const struct fuse_operations ops = {
    .getattr = fsGetattr, .readdir = fsReaddir, .open = fsOpen, .read = fsRead,
    .write = fsWrite, .fsync = fsFsync, .flush = fsFlush,
};
#endif

static void usage(void)
{
    fprintf(stderr, "usage: ce-gemdosfs [--bpb] [--swap] [--rw] <source> <offset> <length> <mountpoint>\n"
                    "       ce-gemdosfs [--bpb] [--swap] --cat <source> <offset> <length>\n"
                    "       ce-gemdosfs [--swap] --probe <source> <offset>\n");
    exit(2);
}

int main(int argc, char **argv)
{
    int cat = 0, probe = 0, i = 1;
    const char *apply = NULL;
    for(; i < argc && argv[i][0] == '-' && argv[i][1] == '-'; i++) {
        if(strcmp(argv[i], "--bpb") == 0) doBpb = 1;
        else if(strcmp(argv[i], "--swap") == 0) doSwap = 1;
        else if(strcmp(argv[i], "--rw") == 0) writable = 1;
        else if(strcmp(argv[i], "--cat") == 0) cat = 1;
        else if(strcmp(argv[i], "--probe") == 0) probe = 1;
        else if(strcmp(argv[i], "--apply") == 0 && i + 1 < argc) { apply = argv[++i]; cat = 1; }
        else usage();
    }
    int need = probe ? 2 : cat ? 3 : 4;
    if(argc - i != need) usage();
    const char *src = argv[i];
    base = strtoll(argv[i + 1], NULL, 0);
    if(base < 0 || (doSwap && (base & 1))) usage();
    srcFd = open(src, (writable ? O_RDWR : O_RDONLY) | O_CLOEXEC);
    if(srcFd < 0) { perror(src); return 1; }

    unsigned char b[512];
    if(probe || doBpb) {
        memset(b, 0, sizeof(b));
        if(readSrc(b, 512, 0) != 512) { printf("ok=no\nwhy=can't read the boot sector\n"); return 1; }
        struct geo g;
        const char *why = "";
        int ok = readGeo(b, &g, &why);
        if(probe) {
            printf("bps=%u\nspc=%u\nclusters=%lu\nfew=%s\nrootfill=%s\nok=%s\n", g.bps, g.spc, ok ? g.clusters : 0UL, ok && g.few ? "yes" : "no", ok && g.rootfill ? "yes" : "no", ok ? "yes" : "no");
            if(!ok) printf("why=%s\n", why);
            return ok ? 0 : 1;
        }
        if(!ok) { fprintf(stderr, "ce-gemdosfs: %s\n", why); return 1; }
        if(writable && !g.rootfill) { fprintf(stderr, "ce-gemdosfs: the root folder doesn't fill its sectors: read-only\n"); return 1; }
        memcpy(vboot, b, 512);
        translate(vboot, &g);
        haveVboot = 1;
        if(g.few) {
            unsigned long rootSecs = ((unsigned long) g.rootent * 32 + g.bps - 1) / g.bps;
            few = 1; nFat = g.nfat;
            fatOff = (off_t) g.res * g.bps;
            fatLen = (off_t) g.spf * g.bps;
            vFatLen = (off_t) g.vspf * g.bps;
            fatReal = (off_t) (g.clusters + 2) * 2;
            if(fatReal > fatLen) fatReal = fatLen;
            realEnd = (off_t) (g.res + (unsigned long) g.nfat * g.spf + rootSecs + g.clusters * g.spc) * g.bps;
            vLength = (off_t) g.vtot * g.bps;
        }
    }
    length = strtoll(argv[i + 2], NULL, 0);
    if(length <= 0) usage();
    if(few && realEnd > length) realEnd = length;               /* a partition shorter than its file system says */

    if(apply) {
        static char buf[1 << 16];
        FILE *f = fopen(apply, "rb");
        if(!f) { perror(apply); return 1; }
        off_t off = 0;
        size_t n;
        while((n = fread(buf, 1, sizeof(buf), f)) > 0) {
            ssize_t r = vwrite(buf, n, off);
            if(r != (ssize_t) n) { fprintf(stderr, "ce-gemdosfs: write at %lld: %ld\n", (long long) off, (long) r); return 1; }
            off += n;
        }
        fclose(f);
        return 0;
    }
    if(cat) {
        static char buf[1 << 16];
        for(off_t off = 0; off < (few ? vLength : length); ) {
            ssize_t r = vread(buf, sizeof(buf), off);
            if(r <= 0) break;
            if(fwrite(buf, 1, r, stdout) != (size_t) r) return 1;
            off += r;
        }
        return 0;
    }
#ifdef NO_FUSE
    fprintf(stderr, "built without FUSE\n");
    return 1;
#else
    char *fargs[] = { argv[0], argv[i + 3], "-s", "-o", writable ? "rw,default_permissions,fsname=ce-gemdosfs" : "ro,default_permissions,fsname=ce-gemdosfs", NULL };
    return fuse_main(5, fargs, &ops, NULL);
#endif
}
