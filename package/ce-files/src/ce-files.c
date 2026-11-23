/* ce-files: the file work of the web interface's Files page (two panes, as
   Midnight Commander). Run by the CosmosEx app without a shell, one command
   per request; the request body comes on stdin, a download goes to stdout.

   A place is where a pane looks:
     storage          /storage
     tr:<X>           /storage/translated_<X>   (a translated drive from a folder)
     usb:<name>       /mnt/<name>               (a USB drive, as the app mounted it)
     shared           /mnt/shared               (the shared drive, autofs)
     img:<n>:<image>  partition <n> of a hard disk image (0: the whole image),
                      mounted by ce-hdinspect ("mount"): writable while the ST
                      has it on no ID; names there are GEMDOS 8.3 in capitals

   Commands (output: key=value lines, or one line per folder entry):
     places                                     place=<id>\t<label>\t<kind>\t<freeKB>\t<totalKB>\t<writable>
                                                image=<path>\t<size bytes>
     ls     <place> <dir>                       writable= names83= freeKB= totalKB=, then
                                                <d|f|l|o>\t<size>\t<mtime>\t<name> (more=yes after 5000)
     cat    <place> <file>                      the file
     zip    <place> <dir> <name>...             those files and folders as one zip (folders whole)
     put    <place> <dir> <name> <size> [overwrite]   stdin -> the file; name=<as stored>
     mkdir  <place> <dir> <name>                name=<as stored>
     rm     <place> <dir> <name>...             files, and folders with what's in them; deleted=<n>
     rename <place> <dir> <from> <to>           name=<as stored>
     fit83  <name>                              the GEMDOS name (for tests)

   Errors: error=<message> and exit 1 (bad request), 2 (not found), 3 (exists:
   exists=<name> too), 4 (refused: read-only, busy).

   Paths never leave a place: a path is walked one folder at a time from the
   place's root with O_NOFOLLOW (no "..", no symlinks), and every change is
   made relative to that folder (openat, mkdirat, unlinkat, renameat).

   For tests the roots can be moved: CE_FILES_STORAGE, CE_FILES_MNT,
   CE_FILES_HDINSPECT (the mount tool). */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <string.h>
#include <strings.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <time.h>
#include <limits.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/file.h>
#include <zlib.h>

#define LIST_MAX    5000
#define E_BAD       1
#define E_NOTFOUND  2
#define E_EXISTS    3
#define E_REFUSED   4

static const char *storageRoot = "/storage";
static const char *mntRoot = "/mnt";
static const char *hdinspect = "/usr/sbin/ce-hdinspect";

struct place {
    char root[PATH_MAX];
    int  writable;
    int  names83;
    int  isImage;
    char roWhy[32];             /* an image partition read-only: attached, experimental, rootfill, file */
};

static void die(int code, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    printf("error=");
    vprintf(fmt, ap);
    printf("\n");
    va_end(ap);
    fflush(stdout);
    exit(code);
}

/* ------------------------------------------------------------- names */

static int validName(const char *n)
{
    size_t len = strlen(n);
    if(len == 0 || len > 255) return 0;
    if(strcmp(n, ".") == 0 || strcmp(n, "..") == 0) return 0;
    for(const unsigned char *c = (const unsigned char *) n; *c; c++)
        if(*c == '/' || *c < 32 || *c == 127) return 0;
    return 1;
}

/* GEMDOS: 8 + 3 in capitals; characters TOS doesn't take become _ */
static void fit83(const char *in, char *out)
{
    char up[512];
    size_t j = 0;
    for(const unsigned char *c = (const unsigned char *) in; *c && j < sizeof(up) - 1; c++) {
        unsigned char ch = (unsigned char) toupper(*c);
        if((ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || strchr("!#$%&'()@^_`{}~.-", ch)) up[j++] = ch;
        else up[j++] = '_';
    }
    up[j] = 0;
    if(up[0] == '.') up[0] = '_';               /* ".hidden" -> "_HIDDEN" */
    char *dot = strrchr(up, '.');
    char base[512] = "", ext[8] = "";
    if(dot) {
        *dot = 0;
        strncat(ext, dot + 1, 3);
    }
    size_t b = 0;
    for(char *c = up; *c && b < 8; c++) if(*c != '.') base[b++] = *c;
    base[b] = 0;
    if(!base[0]) { out[0] = 0; return; }
    for(char *c = ext; *c; c++) if(*c == '.') *c = '_';
    sprintf(out, "%s%s%s", base, ext[0] ? "." : "", ext);
}

/* the name as stored at this place; "" for an unusable one */
static void storedName(const struct place *p, const char *in, char *out)
{
    if(!validName(in)) { out[0] = 0; return; }
    if(p->names83) fit83(in, out);
    else strcpy(out, in);
}

/* ------------------------------------------------------------- places */

static int isMountPoint(const char *path, const char *parent)
{
    struct stat a, b;
    if(stat(path, &a) != 0 || !S_ISDIR(a.st_mode)) return 0;
    if(stat(parent, &b) != 0) return 0;
    return a.st_dev != b.st_dev;
}

static int hasImageExt(const char *name)
{
    static const char *ext[] = { ".img", ".hd", ".hdd", ".ima", ".raw", NULL };
    size_t len = strlen(name);
    for(int i = 0; ext[i]; i++) {
        size_t n = strlen(ext[i]);
        if(len > n && strcasecmp(name + len - n, ext[i]) == 0) return 1;
    }
    return 0;
}

/* an image the Files page may open: in <storage>/hdd_images, or at the top of a USB drive */
static int listedImage(const char *path, char *real)
{
    if(!realpath(path, real)) return 0;
    struct stat st;
    if(stat(real, &st) != 0 || !S_ISREG(st.st_mode)) return 0;
    char dir[PATH_MAX];
    strcpy(dir, real);
    char *slash = strrchr(dir, '/');
    if(!slash) return 0;
    const char *name = slash + 1;
    *slash = 0;
    if(name[0] == '.' || !name[0]) return 0;
    char hdd[PATH_MAX];
    snprintf(hdd, sizeof(hdd), "%s/hdd_images", storageRoot);
    char hddReal[PATH_MAX];
    if(realpath(hdd, hddReal) && strcmp(dir, hddReal) == 0) {
        size_t n = strlen(name);
        return !(n > 5 && strcasecmp(name + n - 5, ".json") == 0);
    }
    /* /mnt/<x>/<image> on a USB drive */
    size_t ml = strlen(mntRoot);
    if(strncmp(dir, mntRoot, ml) == 0 && dir[ml] == '/' && !strchr(dir + ml + 1, '/')
       && strcmp(dir + ml + 1, "shared") != 0 && hasImageExt(name) && isMountPoint(dir, mntRoot)) return 1;
    return 0;
}

/* run ce-hdinspect mount <image> <part>: root=, writable=, fs= */
static void mountImage(const char *image, const char *part, struct place *p)
{
    int fds[2];
    if(pipe(fds) != 0) die(E_BAD, "Can't open the image.");
    pid_t pid = fork();
    if(pid < 0) die(E_BAD, "Can't open the image.");
    if(pid == 0) {
        dup2(fds[1], 1);
        close(fds[0]);
        close(fds[1]);
        int nul = open("/dev/null", O_RDWR);
        if(nul >= 0) { dup2(nul, 0); dup2(nul, 2); }
        execl(hdinspect, hdinspect, "mount", image, part, (char *) NULL);
        _exit(127);
    }
    close(fds[1]);
    char out[8192];
    size_t len = 0;
    ssize_t n;
    while((n = read(fds[0], out + len, sizeof(out) - 1 - len)) > 0) len += n;
    out[len] = 0;
    close(fds[0]);
    int st = 0;
    while(waitpid(pid, &st, 0) < 0 && errno == EINTR) { }
    char fs[16] = "";
    p->root[0] = 0;
    for(char *line = strtok(out, "\n"); line; line = strtok(NULL, "\n")) {
        if(strncmp(line, "root=", 5) == 0) snprintf(p->root, sizeof(p->root), "%s", line + 5);
        else if(strncmp(line, "writable=", 9) == 0) p->writable = strcmp(line + 9, "yes") == 0;
        else if(strncmp(line, "fs=", 3) == 0) snprintf(fs, sizeof(fs), "%s", line + 3);
        else if(strncmp(line, "why_ro=", 7) == 0) snprintf(p->roWhy, sizeof(p->roWhy), "%s", line + 7);
        else if(strncmp(line, "error=", 6) == 0) die(E_REFUSED, "%s", line + 6);
    }
    if(!WIFEXITED(st) || WEXITSTATUS(st) != 0 || !p->root[0]) die(E_BAD, "Can't open the image.");
    p->names83 = strcmp(fs, "fat") == 0;
    p->isImage = 1;
}

static void resolvePlace(const char *id, struct place *p)
{
    memset(p, 0, sizeof(*p));
    if(strcmp(id, "storage") == 0) {
        snprintf(p->root, sizeof(p->root), "%s", storageRoot);
    } else if(strncmp(id, "tr:", 3) == 0 && strlen(id) == 4 && id[3] >= 'C' && id[3] <= 'P') {
        snprintf(p->root, sizeof(p->root), "%s/translated_%c", storageRoot, id[3]);
    } else if(strcmp(id, "shared") == 0) {
        snprintf(p->root, sizeof(p->root), "%s/shared", mntRoot);
    } else if(strncmp(id, "usb:", 4) == 0) {
        const char *n = id + 4;
        if(!validName(n) || strcmp(n, "shared") == 0 || n[0] == '.') die(E_NOTFOUND, "No such place.");
        snprintf(p->root, sizeof(p->root), "%s/%s", mntRoot, n);
        if(!isMountPoint(p->root, mntRoot)) die(E_NOTFOUND, "That USB drive isn't there (unplugged?).");
    } else if(strncmp(id, "img:", 4) == 0) {
        const char *partEnd = strchr(id + 4, ':');
        if(!partEnd || partEnd == id + 4 || partEnd - (id + 4) > 3) die(E_BAD, "Which partition?");
        char part[8];
        snprintf(part, sizeof(part), "%.*s", (int) (partEnd - (id + 4)), id + 4);
        for(char *c = part; *c; c++) if(!isdigit((unsigned char) *c)) die(E_BAD, "Which partition?");
        char real[PATH_MAX];
        if(!listedImage(partEnd + 1, real)) die(E_NOTFOUND, "No such image.");
        mountImage(real, part, p);
        return;
    } else {
        die(E_NOTFOUND, "No such place.");
    }
    struct stat st;
    if(stat(p->root, &st) != 0 || !S_ISDIR(st.st_mode)) die(E_NOTFOUND, "That place isn't there.");
    struct statvfs vf;
    p->writable = statvfs(p->root, &vf) == 0 && !(vf.f_flag & ST_RDONLY);
}

/* the folder <dir> in a place, walked from its root without following links */
static int openDir(const struct place *p, const char *dir)
{
    int fd = open(p->root, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if(fd < 0) die(E_NOTFOUND, "That place isn't there.");
    char buf[PATH_MAX];
    snprintf(buf, sizeof(buf), "%s", dir ? dir : "/");
    char *save = NULL;
    for(char *c = strtok_r(buf, "/", &save); c; c = strtok_r(NULL, "/", &save)) {
        if(strcmp(c, ".") == 0) continue;
        if(strcmp(c, "..") == 0) die(E_BAD, "No .. in paths.");
        int next = openat(fd, c, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if(next < 0) die(E_NOTFOUND, errno == ELOOP || errno == ENOTDIR ? "Not a folder (or a link)." : "No such folder.");
        close(fd);
        fd = next;
    }
    return fd;
}

/* a path's folder and last name: "/A/B/c" -> "/A/B", "c" */
static void splitPath(const char *path, char *dir, char *name)
{
    const char *slash = strrchr(path, '/');
    if(!slash) { strcpy(dir, "/"); snprintf(name, NAME_MAX + 1, "%s", path); return; }
    snprintf(dir, PATH_MAX, "%.*s", (int) (slash - path), path);
    if(!dir[0]) strcpy(dir, "/");
    snprintf(name, NAME_MAX + 1, "%s", slash + 1);
}

static void syncDir(const struct place *p, int dfd)
{
    fsync(dfd);
    if(p->isImage) syncfs(dfd);         /* the image file on the card too */
}

/* the parent folder's owner for new files (pi on /storage; vfat ignores it) */
static void sameOwner(int dfd, int fd, const char *name)
{
    struct stat pst;
    if(fstat(dfd, &pst) != 0) return;
    if(fd >= 0) { if(fchown(fd, pst.st_uid, pst.st_gid) != 0) { } }
    else if(fchownat(dfd, name, pst.st_uid, pst.st_gid, AT_SYMLINK_NOFOLLOW) != 0) { }
}

static void needWritable(const struct place *p)
{
    if(!p->writable) {
        if(p->isImage && strcmp(p->roWhy, "experimental") == 0)
            die(E_REFUSED, "Writing to big Atari partitions and byte-swapped images is experimental: switch it on in Config, Experimental (keep a copy of the image).");
        if(p->isImage && strcmp(p->roWhy, "rootfill") == 0)
            die(E_REFUSED, "This partition's root folder doesn't fill its sectors: it can only be read here.");
        if(p->isImage && strcmp(p->roWhy, "file") == 0) die(E_REFUSED, "The image file itself is read-only.");
        if(p->isImage) die(E_REFUSED, "The ST has this image attached: detach it to change files (the ST keeps its own copy of the folders).");
        die(E_REFUSED, "This place is read-only.");
    }
}

/* The image files the ST has attached to an ID (the app's settings
   HDDIMAGE_<id>, the path with " RO" after it when read-only): they aren't
   replaced, deleted, renamed or moved here, wherever they are. Known by their
   device and inode, so by any name or link. */
static struct { dev_t dev; ino_t ino; } attachedImg[10];
static int attachedCount = -1;
static const char *settingsDir = "/ce/settings";

static void loadAttached(void)
{
    attachedCount = 0;
    for(int i = -1; i < 8; i++) {
        char p[PATH_MAX], v[PATH_MAX + 8];
        if(i < 0) snprintf(p, sizeof(p), "%s/HDDIMAGE", settingsDir);
        else snprintf(p, sizeof(p), "%s/HDDIMAGE_%d", settingsDir, i);
        FILE *f = fopen(p, "r");
        if(!f) continue;
        if(!fgets(v, sizeof(v), f)) v[0] = 0;
        fclose(f);
        size_t n = strlen(v);
        while(n && (v[n - 1] == '\n' || v[n - 1] == '\r' || v[n - 1] == ' ')) v[--n] = 0;
        if(n > 3 && strcmp(v + n - 3, " RO") == 0) v[n - 3] = 0;
        struct stat st;
        if(v[0] == '/' && stat(v, &st) == 0 && S_ISREG(st.st_mode) && attachedCount < 10) {
            attachedImg[attachedCount].dev = st.st_dev;
            attachedImg[attachedCount].ino = st.st_ino;
            attachedCount++;
        }
    }
}

static int isAttached(const struct stat *st)
{
    if(attachedCount < 0) loadAttached();
    if(!S_ISREG(st->st_mode)) return 0;
    for(int i = 0; i < attachedCount; i++) if(attachedImg[i].dev == st->st_dev && attachedImg[i].ino == st->st_ino) return 1;
    return 0;
}
#define ATTACHED_MSG "%s is a hard disk image attached to an ID: detach it on the Hard disk page first."

/* the temporary name of an upload in progress (put): not listed */
static int isUploadTmp(const char *n)
{
    if(strcmp(n, "CEUPLOAD.TMP") == 0) return 1;
    if(strncmp(n, ".ce-upload-", 11) != 0) return 0;
    const char *c = n + 11;
    if(!isdigit((unsigned char) *c)) return 0;
    while(isdigit((unsigned char) *c)) c++;
    return strcmp(c, ".tmp") == 0;
}

/* ------------------------------------------------------------- places / ls */

static void addPlace(const char *id, const char *label, const char *kind, const char *root)
{
    struct statvfs vf;
    unsigned long long freeKB = 0, totalKB = 0;
    int writable = 0;
    if(statvfs(root, &vf) == 0) {
        freeKB = (unsigned long long) vf.f_bavail * vf.f_frsize / 1024;
        totalKB = (unsigned long long) vf.f_blocks * vf.f_frsize / 1024;
        writable = !(vf.f_flag & ST_RDONLY);
    }
    printf("place=%s\t%s\t%s\t%llu\t%llu\t%s\n", id, label, kind, freeKB, totalKB, writable ? "yes" : "no");
}

static void imagesIn(const char *dir, int usbTop)
{
    DIR *d = opendir(dir);
    if(!d) return;
    struct dirent *de;
    while((de = readdir(d)) != NULL) {
        if(de->d_name[0] == '.') continue;
        if(usbTop && !hasImageExt(de->d_name)) continue;
        size_t n = strlen(de->d_name);
        if(n > 5 && strcasecmp(de->d_name + n - 5, ".json") == 0) continue;
        char path[PATH_MAX];
        snprintf(path, sizeof(path), "%s/%s", dir, de->d_name);
        struct stat st;
        if(stat(path, &st) != 0 || !S_ISREG(st.st_mode)) continue;
        if(strchr(path, '\t') || strchr(path, '\n')) continue;
        printf("image=%s\t%lld\n", path, (long long) st.st_size);
    }
    closedir(d);
}

static void cmdPlaces(void)
{
    struct stat st;
    if(stat(storageRoot, &st) == 0 && S_ISDIR(st.st_mode)) {
        addPlace("storage", "Storage (/storage)", "storage", storageRoot);
        for(char l = 'C'; l <= 'P'; l++) {
            char p[PATH_MAX], id[8], label[64];
            snprintf(p, sizeof(p), "%s/translated_%c", storageRoot, l);
            if(lstat(p, &st) != 0 || !S_ISDIR(st.st_mode)) continue;
            snprintf(id, sizeof(id), "tr:%c", l);
            snprintf(label, sizeof(label), "%c: (translated_%c)", l, l);
            addPlace(id, label, "translated", p);
        }
    }
    DIR *d = opendir(mntRoot);
    if(d) {
        struct dirent *de;
        char names[32][NAME_MAX + 1];
        int count = 0;
        while((de = readdir(d)) != NULL && count < 32) {
            if(de->d_name[0] == '.' || strcmp(de->d_name, "shared") == 0 || !validName(de->d_name)) continue;
            if(strchr(de->d_name, '\t')) continue;
            char p[PATH_MAX];
            snprintf(p, sizeof(p), "%s/%s", mntRoot, de->d_name);
            if(!isMountPoint(p, mntRoot)) continue;
            snprintf(names[count++], NAME_MAX + 1, "%s", de->d_name);
        }
        closedir(d);
        qsort(names, count, sizeof(names[0]), (int (*)(const void *, const void *)) strcmp);
        for(int i = 0; i < count; i++) {
            char p[PATH_MAX], id[NAME_MAX + 8], label[NAME_MAX + 32];
            snprintf(p, sizeof(p), "%s/%.255s", mntRoot, names[i]);
            snprintf(id, sizeof(id), "usb:%.255s", names[i]);
            snprintf(label, sizeof(label), "USB drive %.255s", names[i]);
            addPlace(id, label, "usb", p);
        }
    }
    char shared[PATH_MAX];
    snprintf(shared, sizeof(shared), "%s/shared", mntRoot);
    if(lstat(shared, &st) == 0 && S_ISDIR(st.st_mode))         /* (lstat: don't wake autofs) */
        printf("place=shared\tShared drive\tshared\t0\t0\tyes\n");

    /* the images */
    char hdd[PATH_MAX];
    snprintf(hdd, sizeof(hdd), "%s/hdd_images", storageRoot);
    imagesIn(hdd, 0);
    d = opendir(mntRoot);
    if(d) {
        struct dirent *de;
        while((de = readdir(d)) != NULL) {
            if(de->d_name[0] == '.' || strcmp(de->d_name, "shared") == 0) continue;
            char p[PATH_MAX];
            snprintf(p, sizeof(p), "%s/%s", mntRoot, de->d_name);
            if(isMountPoint(p, mntRoot)) imagesIn(p, 1);
        }
        closedir(d);
    }
}

static void cmdLs(const char *placeId, const char *dir)
{
    struct place p;
    resolvePlace(placeId, &p);
    int dfd = openDir(&p, dir);
    struct statvfs vf;
    unsigned long long freeKB = 0, totalKB = 0;
    if(fstatvfs(dfd, &vf) == 0) {
        freeKB = (unsigned long long) vf.f_bavail * vf.f_frsize / 1024;
        totalKB = (unsigned long long) vf.f_blocks * vf.f_frsize / 1024;
    }
    printf("writable=%s\nnames83=%s\nfreeKB=%llu\ntotalKB=%llu\n", p.writable ? "yes" : "no", p.names83 ? "yes" : "no", freeKB, totalKB);
    if(!p.writable && p.roWhy[0]) printf("readonly=%s\n", p.roWhy);
    DIR *d = fdopendir(dfd);
    if(!d) die(E_NOTFOUND, "Can't read that folder.");
    struct dirent *de;
    int n = 0;
    while((de = readdir(d)) != NULL) {
        if(strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0) continue;
        if(strchr(de->d_name, '\t') || strchr(de->d_name, '\n')) continue;
        if(isUploadTmp(de->d_name)) continue;           /* an upload in progress */
        if(++n > LIST_MAX) { printf("more=yes\n"); break; }
        struct stat st;
        char t = 'o';
        long long size = 0, mtime = 0;
        if(fstatat(dirfd(d), de->d_name, &st, AT_SYMLINK_NOFOLLOW) == 0) {
            if(S_ISDIR(st.st_mode)) t = 'd';
            else if(S_ISREG(st.st_mode)) { t = 'f'; size = st.st_size; }
            else if(S_ISLNK(st.st_mode)) t = 'l';
            mtime = st.st_mtime;
        }
        printf("%c\t%lld\t%lld\t%s\n", t, size, mtime, de->d_name);
    }
    closedir(d);
}

/* ------------------------------------------------------------- read */

static void copyOut(int fd, long long max)
{
    static char buf[65536];
    ssize_t n;
    long long left = max;
    while((max < 0 || left > 0) && (n = read(fd, buf, max < 0 || left > (long long) sizeof(buf) ? sizeof(buf) : (size_t) left)) > 0) {
        if(max >= 0) left -= n;
        for(ssize_t w = 0; w < n; ) {
            ssize_t r = write(1, buf + w, n - w);
            if(r < 0 && errno == EINTR) continue;
            if(r <= 0) exit(E_BAD);         /* the browser went away */
            w += r;
        }
    }
}

static void cmdCat(const char *placeId, const char *file, long long max)
{
    struct place p;
    resolvePlace(placeId, &p);
    char dir[PATH_MAX], name[NAME_MAX + 1];
    splitPath(file, dir, name);
    if(!validName(name)) die(E_BAD, "Which file?");
    int dfd = openDir(&p, dir);
    int fd = openat(dfd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    struct stat st;
    if(fd < 0 || fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) die(E_NOTFOUND, "No such file.");
    copyOut(fd, max);
    close(fd);
}

/* ------------------------------------------------------------- zip */

/* streamed: each file's sizes and CRC follow its data (flag bit 3), the
   central directory at the end; names UTF-8 (bit 11); deflate (zlib) */
struct zipEntry { char *name; unsigned crc; unsigned long long csize, size; unsigned long long offset; unsigned dosTime, dosDate; int dir; };
static struct zipEntry *zents = NULL;
static size_t zcount = 0, zcap = 0;
static unsigned long long zpos = 0;

static void zout(const void *data, size_t len)
{
    const char *b = (const char *) data;
    for(size_t w = 0; w < len; ) {
        ssize_t r = write(1, b + w, len - w);
        if(r < 0 && errno == EINTR) continue;
        if(r <= 0) exit(E_BAD);
        w += r;
    }
    zpos += len;
}

static void put16(unsigned char *p, unsigned v) { p[0] = v & 0xff; p[1] = (v >> 8) & 0xff; }
static void put32(unsigned char *p, unsigned long v) { put16(p, v & 0xffff); put16(p + 2, (v >> 16) & 0xffff); }

static void dosTime(time_t t, unsigned *tm, unsigned *dt)
{
    struct tm lt;
    localtime_r(&t, &lt);
    if(lt.tm_year < 80) { lt.tm_year = 80; lt.tm_mon = 0; lt.tm_mday = 1; lt.tm_hour = lt.tm_min = lt.tm_sec = 0; }
    *tm = (lt.tm_hour << 11) | (lt.tm_min << 5) | (lt.tm_sec / 2);
    *dt = ((lt.tm_year - 80) << 9) | ((lt.tm_mon + 1) << 5) | lt.tm_mday;
}

static struct zipEntry *zipBegin(const char *name, time_t mtime, int dir)
{
    if(zcount == zcap) {
        zcap = zcap ? zcap * 2 : 64;
        zents = realloc(zents, zcap * sizeof(*zents));
        if(!zents) exit(E_BAD);
    }
    if(zcount >= 65535 || zpos > 0xF0000000ULL) {
        fprintf(stderr, "zip too large\n");
        exit(E_BAD);
    }
    struct zipEntry *e = &zents[zcount++];
    memset(e, 0, sizeof(*e));
    e->name = strdup(name);
    e->dir = dir;
    e->offset = zpos;
    dosTime(mtime, &e->dosTime, &e->dosDate);
    unsigned char h[30];
    size_t nl = strlen(name);
    put32(h, 0x04034b50);
    put16(h + 4, 20);                           /* version needed */
    put16(h + 6, (dir ? 0 : 0x0008) | 0x0800);  /* data descriptor, UTF-8 */
    put16(h + 8, dir ? 0 : 8);                  /* deflate */
    put16(h + 10, e->dosTime);
    put16(h + 12, e->dosDate);
    put32(h + 14, 0); put32(h + 18, 0); put32(h + 22, 0);
    put16(h + 26, nl);
    put16(h + 28, 0);
    zout(h, 30);
    zout(name, nl);
    return e;
}

static void zipFile(int fd, const char *name, time_t mtime)
{
    struct zipEntry *e = zipBegin(name, mtime, 0);
    static unsigned char in[65536], out[65536];
    z_stream zs;
    memset(&zs, 0, sizeof(zs));
    if(deflateInit2(&zs, 3, Z_DEFLATED, -15, 8, Z_DEFAULT_STRATEGY) != Z_OK) exit(E_BAD);
    unsigned long crc = crc32(0, NULL, 0);
    ssize_t n;
    int flush;
    do {
        n = read(fd, in, sizeof(in));
        if(n < 0) n = 0;
        flush = n == 0 ? Z_FINISH : Z_NO_FLUSH;
        crc = crc32(crc, in, n);
        e->size += n;
        zs.next_in = in;
        zs.avail_in = n;
        do {
            zs.next_out = out;
            zs.avail_out = sizeof(out);
            deflate(&zs, flush);
            size_t have = sizeof(out) - zs.avail_out;
            zout(out, have);
            e->csize += have;
        } while(zs.avail_out == 0);
    } while(flush != Z_FINISH);
    deflateEnd(&zs);
    e->crc = crc;
    unsigned char dd[16];
    put32(dd, 0x08074b50);
    put32(dd + 4, e->crc);
    put32(dd + 8, e->csize);
    put32(dd + 12, e->size);
    zout(dd, 16);
}

static void zipTree(int dfd, const char *name, const char *zname, int depth)
{
    struct stat st;
    if(fstatat(dfd, name, &st, AT_SYMLINK_NOFOLLOW) != 0) return;
    if(S_ISREG(st.st_mode)) {
        int fd = openat(dfd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
        if(fd < 0) return;
        zipFile(fd, zname, st.st_mtime);
        close(fd);
    } else if(S_ISDIR(st.st_mode) && depth < 32) {
        char dname[PATH_MAX];
        snprintf(dname, sizeof(dname), "%s/", zname);
        zipBegin(dname, st.st_mtime, 1);
        int sub = openat(dfd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if(sub < 0) return;
        DIR *d = fdopendir(sub);
        if(!d) { close(sub); return; }
        struct dirent *de;
        while((de = readdir(d)) != NULL) {
            if(strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0) continue;
            char child[PATH_MAX];
            snprintf(child, sizeof(child), "%s/%s", zname, de->d_name);
            zipTree(dirfd(d), de->d_name, child, depth + 1);
        }
        closedir(d);
    }                                           /* links and others: left out */
}

static void cmdZip(const char *placeId, const char *dir, int count, char **names)
{
    struct place p;
    resolvePlace(placeId, &p);
    int dfd = openDir(&p, dir);
    for(int i = 0; i < count; i++) if(!validName(names[i])) die(E_BAD, "Not a valid name: %s", names[i]);
    for(int i = 0; i < count; i++) {
        struct stat st;
        if(fstatat(dfd, names[i], &st, AT_SYMLINK_NOFOLLOW) != 0) die(E_NOTFOUND, "No such file: %s", names[i]);
    }
    fflush(stdout);
    for(int i = 0; i < count; i++) zipTree(dfd, names[i], names[i], 0);
    unsigned long long cdStart = zpos;
    for(size_t i = 0; i < zcount; i++) {
        struct zipEntry *e = &zents[i];
        unsigned char h[46];
        size_t nl = strlen(e->name);
        put32(h, 0x02014b50);
        put16(h + 4, 0x031e);                   /* made by: Unix, 3.0 */
        put16(h + 6, 20);
        put16(h + 8, (e->dir ? 0 : 0x0008) | 0x0800);
        put16(h + 10, e->dir ? 0 : 8);
        put16(h + 12, e->dosTime);
        put16(h + 14, e->dosDate);
        put32(h + 16, e->crc);
        put32(h + 20, e->csize);
        put32(h + 24, e->size);
        put16(h + 28, nl);
        put16(h + 30, 0); put16(h + 32, 0); put16(h + 34, 0); put16(h + 36, 0);
        put32(h + 38, e->dir ? (040755UL << 16) | 0x10 : (0100644UL << 16));
        put32(h + 42, e->offset);
        zout(h, 46);
        zout(e->name, nl);
    }
    unsigned char end[22];
    put32(end, 0x06054b50);
    put16(end + 4, 0); put16(end + 6, 0);
    put16(end + 8, zcount); put16(end + 10, zcount);
    put32(end + 12, zpos - cdStart);
    put32(end + 16, cdStart);
    put16(end + 20, 0);
    zout(end, 22);
}

/* ------------------------------------------------------------- changes */

static void cmdPut(const char *placeId, const char *dir, const char *nameIn, const char *sizeStr, int overwrite)
{
    char *endp;
    long long size = strtoll(sizeStr, &endp, 10);
    if(!sizeStr[0] || *endp || size < 0) die(E_BAD, "How big is the file?");
    struct place p;
    resolvePlace(placeId, &p);
    needWritable(&p);
    char name[NAME_MAX + 1];
    storedName(&p, nameIn, name);
    if(!name[0]) die(E_BAD, "Not a valid name.");
    int dfd = openDir(&p, dir);
    struct stat st;
    long long have = 0;
    if(fstatat(dfd, name, &st, AT_SYMLINK_NOFOLLOW) == 0) {
        if(!S_ISREG(st.st_mode)) die(E_EXISTS, "%s is already there (a folder or a link).", name);
        if(!overwrite) { printf("exists=%s\n", name); die(E_EXISTS, "%s is already there.", name); }
        if(isAttached(&st)) die(E_REFUSED, ATTACHED_MSG, name);
        have = st.st_size;
    }
    struct statvfs vf;
    if(fstatvfs(dfd, &vf) == 0) {
        unsigned long long freeB = (unsigned long long) vf.f_bavail * vf.f_frsize;
        if((unsigned long long) size > freeB + have) die(E_REFUSED, "Not enough room here: %llu KB free.", freeB / 1024);
    }
    char tmp[64];
    if(p.names83) strcpy(tmp, "CEUPLOAD.TMP");
    else snprintf(tmp, sizeof(tmp), ".ce-upload-%d.tmp", (int) getpid());
    unlinkat(dfd, tmp, 0);
    int fd = openat(dfd, tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0666);
    if(fd < 0) die(E_REFUSED, "Can't write here: %s", strerror(errno));
    static char buf[65536];
    long long got = 0;
    int ok = 1;
    while(got < size) {
        size_t want = size - got < (long long) sizeof(buf) ? (size_t) (size - got) : sizeof(buf);
        ssize_t n = read(0, buf, want);
        if(n < 0 && errno == EINTR) continue;
        if(n <= 0) break;
        for(ssize_t w = 0; w < n; ) {
            ssize_t r = write(fd, buf + w, n - w);
            if(r < 0 && errno == EINTR) continue;
            if(r <= 0) { ok = 0; break; }
            w += r;
        }
        if(!ok) break;
        got += n;
    }
    if(fsync(fd) != 0) ok = 0;
    sameOwner(dfd, fd, NULL);
    close(fd);
    if(!ok || got != size) {
        unlinkat(dfd, tmp, 0);
        syncDir(&p, dfd);
        die(ok ? E_BAD : E_REFUSED, ok ? "The upload was cut short." : "Writing the file failed (full?).");
    }
    if(renameat(dfd, tmp, dfd, name) != 0) {
        unlinkat(dfd, tmp, 0);
        die(E_REFUSED, "Writing the file failed: %s", strerror(errno));
    }
    syncDir(&p, dfd);
    printf("name=%s\nsize=%lld\n", name, size);
}

static void cmdMkdir(const char *placeId, const char *dir, const char *nameIn)
{
    struct place p;
    resolvePlace(placeId, &p);
    needWritable(&p);
    char name[NAME_MAX + 1];
    storedName(&p, nameIn, name);
    if(!name[0]) die(E_BAD, "Not a valid name.");
    int dfd = openDir(&p, dir);
    if(mkdirat(dfd, name, 0775) != 0) {
        if(errno == EEXIST) { printf("exists=%s\n", name); die(E_EXISTS, "%s is already there.", name); }
        die(E_REFUSED, "Can't make the folder: %s", strerror(errno));
    }
    sameOwner(dfd, -1, name);
    syncDir(&p, dfd);
    printf("name=%s\n", name);
}

static int removeTree(int dfd, const char *name, int depth)
{
    struct stat st;
    if(fstatat(dfd, name, &st, AT_SYMLINK_NOFOLLOW) != 0) return -1;
    if(isAttached(&st)) { errno = ETXTBSY; return -1; }     /* (ETXTBSY: only from here) */
    if(!S_ISDIR(st.st_mode)) return unlinkat(dfd, name, 0);
    if(depth > 64) return -1;
    int sub = openat(dfd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if(sub < 0) return -1;
    DIR *d = fdopendir(sub);
    if(!d) { close(sub); return -1; }
    struct dirent *de;
    int rc = 0;
    while((de = readdir(d)) != NULL) {
        if(strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0) continue;
        if(removeTree(dirfd(d), de->d_name, depth + 1) != 0) rc = -1;
    }
    closedir(d);
    if(rc == 0) rc = unlinkat(dfd, name, AT_REMOVEDIR);
    return rc;
}

static void cmdRm(const char *placeId, const char *dir, int count, char **names)
{
    struct place p;
    resolvePlace(placeId, &p);
    needWritable(&p);
    for(int i = 0; i < count; i++) if(!validName(names[i])) die(E_BAD, "Not a valid name: %s", names[i]);
    int dfd = openDir(&p, dir);
    int done = 0;
    for(int i = 0; i < count; i++) {
        struct stat st;
        if(fstatat(dfd, names[i], &st, AT_SYMLINK_NOFOLLOW) != 0) continue;     /* gone already */
        if(removeTree(dfd, names[i], 0) != 0) {
            syncDir(&p, dfd);
            printf("deleted=%d\n", done);
            if(errno == ETXTBSY) die(E_REFUSED, "Can't delete %s: it is, or has in it, a hard disk image attached to an ID. Detach it on the Hard disk page first.", names[i]);
            die(E_REFUSED, "Can't delete %s: %s", names[i], strerror(errno));
        }
        done++;
    }
    syncDir(&p, dfd);
    printf("deleted=%d\n", done);
}

static void cmdRename(const char *placeId, const char *dir, const char *from, const char *toIn)
{
    struct place p;
    resolvePlace(placeId, &p);
    needWritable(&p);
    if(!validName(from)) die(E_BAD, "Which file?");
    char to[NAME_MAX + 1];
    storedName(&p, toIn, to);
    if(!to[0]) die(E_BAD, "Not a valid name.");
    int dfd = openDir(&p, dir);
    struct stat st;
    if(fstatat(dfd, from, &st, AT_SYMLINK_NOFOLLOW) != 0) die(E_NOTFOUND, "No such file: %s", from);
    if(isAttached(&st)) die(E_REFUSED, ATTACHED_MSG, from);
    if(strcmp(from, to) == 0) { printf("name=%s\n", to); return; }
    /* only a different case of the same name (FAT is case-blind): allowed */
    if(fstatat(dfd, to, &st, AT_SYMLINK_NOFOLLOW) == 0 && strcasecmp(from, to) != 0) {
        printf("exists=%s\n", to);
        die(E_EXISTS, "%s is already there.", to);
    }
    if(renameat(dfd, from, dfd, to) != 0) die(E_REFUSED, "Can't rename: %s", strerror(errno));
    syncDir(&p, dfd);
    printf("name=%s\n", to);
}

/* ------------------------------------------------------------- jobs: copy, move */

/* One job at a time, in the background (a copy can take minutes): job-start
   checks everything it can, prints started=1 and leaves a daemon doing the
   work; job-status reads its progress (key=value lines), job-cancel asks it
   to stop (the file being written is removed). The daemon holds the lock and
   the folders it uses open, so image partitions stay mounted under it (and
   an image can't be attached meanwhile: ce-hdinspect close fails, busy). */

static const char *runDir = "/run/ce-files";

static struct {
    char op[8];
    unsigned long long totalBytes, doneBytes;
    unsigned long totalFiles, doneFiles, skipped;
    char current[PATH_MAX];
    char renamed[1600];
    char err[512];
    long started;
    double lastWrite;
    int cancelled;
    char stamps[2][PATH_MAX];
    time_t lastStamp;
} J;

static double nowS(void)
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec / 1e9;
}

static void runFile(char *out, const char *name) { snprintf(out, PATH_MAX, "%s/%s", runDir, name); }

static void jobWrite(const char *state, const char *message)
{
    char tmp[PATH_MAX], fin[PATH_MAX];
    runFile(tmp, "status.new");
    runFile(fin, "status");
    FILE *f = fopen(tmp, "w");
    if(!f) return;
    fprintf(f, "state=%s\nop=%s\ntotalBytes=%llu\ndoneBytes=%llu\ntotalFiles=%lu\ndoneFiles=%lu\nskipped=%lu\ncurrent=%s\nstarted=%ld\n",
            state, J.op, J.totalBytes, J.doneBytes, J.totalFiles, J.doneFiles, J.skipped, J.current, J.started);
    if(message && message[0]) fprintf(f, "message=%s\n", message);
    if(J.renamed[0]) fprintf(f, "renamed=%s\n", J.renamed);
    fclose(f);
    rename(tmp, fin);
}

/* progress (at most every 0.3 s), image sessions kept alive, cancel checked */
static void jobTick(int force)
{
    double t = nowS();
    if(force || t - J.lastWrite > 0.3) { jobWrite("running", NULL); J.lastWrite = t; }
    if(time(NULL) - J.lastStamp >= 10) {
        for(int i = 0; i < 2; i++) if(J.stamps[i][0]) utimensat(AT_FDCWD, J.stamps[i], NULL, 0);
        J.lastStamp = time(NULL);
    }
    char c[PATH_MAX];
    runFile(c, "cancel");
    if(access(c, F_OK) == 0) J.cancelled = 1;
}

static void addRenamed(const char *from, const char *to)
{
    size_t n = strlen(J.renamed);
    if(n > sizeof(J.renamed) - 600) {
        if(!strstr(J.renamed, "|...")) strcat(J.renamed, "|...");
        return;
    }
    snprintf(J.renamed + n, sizeof(J.renamed) - n, "%s%.250s -> %.250s", n ? "|" : "", from, to);
}

static int listable(const char *n)
{
    return strcmp(n, ".") && strcmp(n, "..") && !strchr(n, '\t') && !strchr(n, '\n') && !isUploadTmp(n) && validName(n);
}

static void measure(int dfd, const char *name, int depth)
{
    struct stat st;
    if(fstatat(dfd, name, &st, AT_SYMLINK_NOFOLLOW) != 0) return;
    if(S_ISREG(st.st_mode)) { J.totalBytes += st.st_size; J.totalFiles++; return; }
    if(!S_ISDIR(st.st_mode) || depth > 64) return;
    int sub = openat(dfd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if(sub < 0) return;
    DIR *d = fdopendir(sub);
    if(!d) { close(sub); return; }
    struct dirent *de;
    while((de = readdir(d)) != NULL) if(listable(de->d_name)) measure(dirfd(d), de->d_name, depth + 1);
    closedir(d);
}

/* a 8.3 name not used yet in this folder by this job: NAME~1.EXT, NAME~2 ... */
struct nameSet { char (*v)[16]; size_t n, cap; };

static void uniqueName(struct nameSet *ns, char *name)
{
    for(int k = 0; k < 1000; k++) {
        char cand[16];
        if(k == 0) snprintf(cand, sizeof(cand), "%s", name);
        else {
            char base[16], ext[8] = "";
            snprintf(base, sizeof(base), "%s", name);
            char *dot = strchr(base, '.');
            if(dot) { snprintf(ext, sizeof(ext), "%s", dot); *dot = 0; }
            char suf[8];
            int sl = snprintf(suf, sizeof(suf), "~%d", k);
            if((int) strlen(base) > 8 - sl) base[8 - sl] = 0;
            snprintf(cand, sizeof(cand), "%s%s%s", base, suf, ext);
        }
        int used = 0;
        for(size_t i = 0; i < ns->n; i++) if(strcasecmp(ns->v[i], cand) == 0) { used = 1; break; }
        if(!used) {
            if(ns->n == ns->cap) { ns->cap = ns->cap ? ns->cap * 2 : 32; ns->v = realloc(ns->v, ns->cap * sizeof(*ns->v)); if(!ns->v) exit(E_BAD); }
            snprintf(ns->v[ns->n++], 16, "%s", cand);
            strcpy(name, cand);
            return;
        }
    }
}

/* the name at the target: 8.3 there (unique in this folder for this job) */
static void targetName(const struct place *tp, struct nameSet *ns, const char *name, char *out)
{
    if(!tp->names83) { strcpy(out, name); return; }
    fit83(name, out);
    if(!out[0]) strcpy(out, "NONAME");
    uniqueName(ns, out);
}

static int copyFile(int sdfd, const char *sname, int ddfd, const char *dname, const struct place *tp, int replace)
{
    struct stat sst, dst;
    if(fstatat(sdfd, sname, &sst, AT_SYMLINK_NOFOLLOW) != 0 || !S_ISREG(sst.st_mode)) { J.skipped++; return 0; }
    if(fstatat(ddfd, dname, &dst, AT_SYMLINK_NOFOLLOW) == 0) {
        if(!S_ISREG(dst.st_mode)) { snprintf(J.err, sizeof(J.err), "%s is a folder at the target; not replaced by a file.", dname); return -1; }
        if(!replace) { J.skipped++; J.doneBytes += sst.st_size; return 0; }
        if(isAttached(&dst)) { snprintf(J.err, sizeof(J.err), ATTACHED_MSG, dname); return -1; }
    }
    int in = openat(sdfd, sname, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if(in < 0) { snprintf(J.err, sizeof(J.err), "Can't read %s: %s", sname, strerror(errno)); return -1; }
    char tmp[64];
    if(tp->names83) strcpy(tmp, "CEUPLOAD.TMP");
    else snprintf(tmp, sizeof(tmp), ".ce-upload-%d.tmp", (int) getpid());
    unlinkat(ddfd, tmp, 0);
    int out = openat(ddfd, tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0666);
    if(out < 0) { close(in); snprintf(J.err, sizeof(J.err), "Can't write at the target: %s", strerror(errno)); return -1; }
    static char buf[262144];
    ssize_t n;
    int rc = 0;
    while((n = read(in, buf, sizeof(buf))) > 0) {
        for(ssize_t w = 0; w < n; ) {
            ssize_t r = write(out, buf + w, n - w);
            if(r < 0 && errno == EINTR) continue;
            if(r <= 0) { snprintf(J.err, sizeof(J.err), "Writing %s failed: %s", dname, r < 0 ? strerror(errno) : "full?"); rc = -1; break; }
            w += r;
        }
        if(rc) break;
        J.doneBytes += n;
        jobTick(0);
        if(J.cancelled) { rc = -2; break; }
    }
    if(n < 0 && !rc) { snprintf(J.err, sizeof(J.err), "Reading %s failed: %s", sname, strerror(errno)); rc = -1; }
    if(!rc && fsync(out) != 0) { snprintf(J.err, sizeof(J.err), "Writing %s failed: %s", dname, strerror(errno)); rc = -1; }
    if(!rc) {
        struct timespec ts[2] = { sst.st_atim, sst.st_mtim };      /* the file's date kept */
        futimens(out, ts);
        sameOwner(ddfd, out, NULL);
    }
    close(out);
    close(in);
    if(rc) { unlinkat(ddfd, tmp, 0); return rc; }
    if(renameat(ddfd, tmp, ddfd, dname) != 0) {
        unlinkat(ddfd, tmp, 0);
        snprintf(J.err, sizeof(J.err), "Writing %s failed: %s", dname, strerror(errno));
        return -1;
    }
    J.doneFiles++;
    return 0;
}

static int copyTree(int sdfd, const char *sname, int ddfd, const char *dname, const struct place *tp, int replace, int depth, const char *rel);

static int copyDir(int sfd, int dfd, const struct place *tp, int replace, int depth, const char *rel)
{
    DIR *d = fdopendir(sfd);
    if(!d) { close(sfd); return -1; }
    struct nameSet ns = { NULL, 0, 0 };
    struct dirent *de;
    int rc = 0;
    while(!rc && (de = readdir(d)) != NULL) {
        if(!listable(de->d_name)) continue;
        char out[NAME_MAX + 1], childRel[PATH_MAX];
        targetName(tp, &ns, de->d_name, out);
        snprintf(childRel, sizeof(childRel), "%s/%s", rel, de->d_name);
        if(tp->names83 && strcmp(out, de->d_name) != 0) addRenamed(childRel, out);
        rc = copyTree(dirfd(d), de->d_name, dfd, out, tp, replace, depth + 1, childRel);
    }
    closedir(d);
    free(ns.v);
    return rc;
}

static int copyTree(int sdfd, const char *sname, int ddfd, const char *dname, const struct place *tp, int replace, int depth, const char *rel)
{
    struct stat st, dst;
    if(fstatat(sdfd, sname, &st, AT_SYMLINK_NOFOLLOW) != 0) return 0;
    snprintf(J.current, sizeof(J.current), "%s", rel);
    if(S_ISREG(st.st_mode)) return copyFile(sdfd, sname, ddfd, dname, tp, replace);
    if(!S_ISDIR(st.st_mode)) { J.skipped++; return 0; }          /* links and others */
    if(depth > 64) { snprintf(J.err, sizeof(J.err), "Folders nested too deep."); return -1; }
    if(fstatat(ddfd, dname, &dst, AT_SYMLINK_NOFOLLOW) == 0) {
        if(!S_ISDIR(dst.st_mode)) { snprintf(J.err, sizeof(J.err), "%s is a file at the target; not replaced by a folder.", dname); return -1; }
    } else if(mkdirat(ddfd, dname, 0775) != 0) {
        snprintf(J.err, sizeof(J.err), "Can't make the folder %s: %s", dname, strerror(errno));
        return -1;
    } else sameOwner(ddfd, -1, dname);
    int sfd = openat(sdfd, sname, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int dfd = openat(ddfd, dname, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if(sfd < 0 || dfd < 0) {
        if(sfd >= 0) close(sfd);
        if(dfd >= 0) close(dfd);
        snprintf(J.err, sizeof(J.err), "Can't open the folder %s.", dname);
        return -1;
    }
    int rc = copyDir(sfd, dfd, tp, replace, depth, rel);
    if(!rc) fsync(dfd);
    close(dfd);
    return rc;
}

/* is the folder dfd (or one above it, up to the place's root) the item (dev, ino)? */
static int inside(int dfd, dev_t dev, ino_t ino, int rootFd)
{
    struct stat root, cur;
    if(fstat(rootFd, &root) != 0) return 0;
    int fd = dup(dfd);
    for(int i = 0; fd >= 0 && i < 128; i++) {
        if(fstat(fd, &cur) != 0) break;
        if(cur.st_dev == dev && cur.st_ino == ino) { close(fd); return 1; }
        if(cur.st_dev == root.st_dev && cur.st_ino == root.st_ino) break;
        int up = openat(fd, "..", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        close(fd);
        fd = up;
    }
    if(fd >= 0) close(fd);
    return 0;
}

static void sessionStamp(const struct place *p, char *out)
{
    out[0] = 0;
    if(!p->isImage) return;
    snprintf(out, PATH_MAX, "%s", p->root);
    char *slash = strrchr(out, '/');
    if(slash) strcpy(slash, "/stamp"); else out[0] = 0;
}

/* job-start copy|move <fromPlace> <fromDir> <toPlace> <toDir> replace|skip <name>... */
static void cmdJobStart(int argc, char **argv)
{
    const char *op = argv[2], *fromId = argv[3], *fromDir = argv[4], *toId = argv[5], *toDir = argv[6];
    int replace = strcmp(argv[7], "replace") == 0;
    int count = argc - 8;
    char **names = argv + 8;
    int move = strcmp(op, "move") == 0;
    if(!move && strcmp(op, "copy") != 0) die(E_BAD, "copy or move?");
    for(int i = 0; i < count; i++) if(!validName(names[i])) die(E_BAD, "Not a valid name: %s", names[i]);
    mkdir(runDir, 0755);
    char lockPath[PATH_MAX];
    runFile(lockPath, "job.lock");
    int lk = open(lockPath, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
    if(lk < 0 || flock(lk, LOCK_EX | LOCK_NB) != 0) die(E_REFUSED, "Another copy or move is running: wait for it, or cancel it.");

    struct place fp, tp;
    resolvePlace(fromId, &fp);
    resolvePlace(toId, &tp);
    needWritable(&tp);
    if(move) needWritable(&fp);
    int fRoot = open(fp.root, O_RDONLY | O_DIRECTORY | O_CLOEXEC), tRoot = open(tp.root, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    int sdfd = openDir(&fp, fromDir), ddfd = openDir(&tp, toDir);
    if(fRoot < 0 || tRoot < 0) die(E_NOTFOUND, "That place isn't there.");
    struct stat sd, dd;
    fstat(sdfd, &sd);
    fstat(ddfd, &dd);
    memset(&J, 0, sizeof(J));
    snprintf(J.op, sizeof(J.op), "%s", op);
    for(int i = 0; i < count; i++) {
        struct stat st;
        if(fstatat(sdfd, names[i], &st, AT_SYMLINK_NOFOLLOW) != 0) die(E_NOTFOUND, "No such file: %s", names[i]);
        if(S_ISDIR(st.st_mode) && inside(ddfd, st.st_dev, st.st_ino, tRoot)) die(E_BAD, "%s can't go into itself.", names[i]);
        measure(sdfd, names[i], 0);
    }
    int sameDir = sd.st_dev == dd.st_dev && sd.st_ino == dd.st_ino;
    if(sameDir && !(tp.names83 && !fp.names83)) die(E_BAD, "That's the same folder.");
    int sameFs = sd.st_dev == dd.st_dev;
    struct statvfs vf;
    if(!(move && sameFs) && fstatvfs(ddfd, &vf) == 0) {
        unsigned long long freeB = (unsigned long long) vf.f_bavail * vf.f_frsize;
        if(J.totalBytes > freeB) die(E_REFUSED, "Not enough room at the target: %llu MB needed, %llu MB free.", J.totalBytes >> 20, freeB >> 20);
    }
    sessionStamp(&fp, J.stamps[0]);
    sessionStamp(&tp, J.stamps[1]);
    char c[PATH_MAX];
    runFile(c, "cancel");
    unlink(c);
    J.started = (long) time(NULL);
    jobWrite("running", NULL);
    printf("started=1\ntotalBytes=%llu\ntotalFiles=%lu\n", J.totalBytes, J.totalFiles);
    fflush(stdout);

    /* the daemon: away from the app's pipes, its own session; keeps the lock */
    pid_t pid = fork();
    if(pid < 0) { jobWrite("failed", "Couldn't start."); die(E_BAD, "Couldn't start."); }
    if(pid > 0) _exit(0);
    setsid();
    if(fork() > 0) _exit(0);
    int nul = open("/dev/null", O_RDWR);
    if(nul >= 0) { dup2(nul, 0); dup2(nul, 1); dup2(nul, 2); if(nul > 2) close(nul); }

    struct nameSet ns = { NULL, 0, 0 };
    int rc = 0;
    for(int i = 0; i < count && !rc && !J.cancelled; i++) {
        char out[NAME_MAX + 1];
        targetName(&tp, &ns, names[i], out);
        if(strcmp(out, names[i]) != 0) addRenamed(names[i], out);
        struct stat st, ex;
        fstatat(sdfd, names[i], &st, AT_SYMLINK_NOFOLLOW);
        int there = fstatat(ddfd, out, &ex, AT_SYMLINK_NOFOLLOW) == 0;
        snprintf(J.current, sizeof(J.current), "%s", names[i]);
        jobTick(1);
        if((move && isAttached(&st)) || (there && replace && isAttached(&ex))) {
            snprintf(J.err, sizeof(J.err), ATTACHED_MSG, move && isAttached(&st) ? names[i] : out);
            rc = -1;
            break;
        }
        /* a move on the same file system: a rename, when nothing's in the way */
        if(move && sameFs && (!there || (replace && S_ISREG(st.st_mode) && S_ISREG(ex.st_mode)))) {
            if(renameat(sdfd, names[i], ddfd, out) == 0) {
                if(S_ISREG(st.st_mode)) { J.doneBytes += st.st_size; J.doneFiles++; }
                else J.doneFiles++;                     /* (a folder moved whole: counted once) */
                continue;
            }
        }
        if(there && !replace) {
            J.skipped++;
            continue;
        }
        rc = copyTree(sdfd, names[i], ddfd, out, &tp, replace, 0, names[i]);
        if(!rc && move && removeTree(sdfd, names[i], 0) != 0) {
            if(errno == ETXTBSY) snprintf(J.err, sizeof(J.err), "Copied, but %s stays where it was: it has in it a hard disk image attached to an ID.", names[i]);
            else snprintf(J.err, sizeof(J.err), "Copied, but couldn't delete %s from where it was: %s", names[i], strerror(errno));
            rc = -1;
        }
    }
    syncDir(&tp, ddfd);
    if(move) syncDir(&fp, sdfd);
    if(tp.isImage || fp.isImage) sync();
    char msg[700];
    if(J.cancelled || rc == -2) {
        snprintf(msg, sizeof(msg), "Cancelled after %lu file%s.", J.doneFiles, J.doneFiles == 1 ? "" : "s");
        J.current[0] = 0;
        jobWrite("cancelled", msg);
    } else if(rc) {
        jobWrite("failed", J.err[0] ? J.err : "That didn't work.");
    } else {
        if(move && sameFs) J.doneBytes = J.totalBytes;
        snprintf(msg, sizeof(msg), "%s %lu file%s%s.", move ? "Moved" : "Copied", J.doneFiles, J.doneFiles == 1 ? "" : "s",
                 J.skipped ? " (some left out: already there, links)" : "");
        J.current[0] = 0;
        jobWrite("done", msg);
    }
    char cf[PATH_MAX];
    runFile(cf, "cancel");
    unlink(cf);
    _exit(0);
}

static void cmdJobStatus(void)
{
    char lockPath[PATH_MAX], st[PATH_MAX];
    runFile(lockPath, "job.lock");
    runFile(st, "status");
    FILE *f = fopen(st, "r");
    if(!f) { printf("state=idle\n"); return; }
    char line[4096];
    int running = 0;
    char buf[16384] = "";
    while(fgets(line, sizeof(line), f)) {
        if(strcmp(line, "state=running\n") == 0) running = 1;
        if(strlen(buf) + strlen(line) < sizeof(buf)) strcat(buf, line);
    }
    fclose(f);
    if(running) {                               /* is the daemon still there? */
        int lk = open(lockPath, O_RDWR | O_CLOEXEC);
        if(lk >= 0 && flock(lk, LOCK_EX | LOCK_NB) == 0) {
            char *p = strstr(buf, "state=running\n");
            printf("state=failed\nmessage=The copy stopped unexpectedly.\n%s", p ? p + 14 : buf);
            close(lk);
            return;
        }
        if(lk >= 0) close(lk);
    }
    fputs(buf, stdout);
}

static void cmdJobCancel(void)
{
    char c[PATH_MAX];
    mkdir(runDir, 0755);
    runFile(c, "cancel");
    int fd = open(c, O_WRONLY | O_CREAT | O_CLOEXEC, 0600);
    if(fd >= 0) close(fd);
    printf("cancel=1\n");
}

/* conflicts <toPlace> <toDir> <name>...: the names (as stored there) already there */
static void cmdConflicts(int count, char **argv)
{
    struct place tp;
    resolvePlace(argv[2], &tp);
    int ddfd = openDir(&tp, argv[3]);
    struct statvfs vf;
    if(fstatvfs(ddfd, &vf) == 0) printf("freeKB=%llu\n", (unsigned long long) vf.f_bavail * vf.f_frsize / 1024);
    printf("writable=%s\nnames83=%s\n", tp.writable ? "yes" : "no", tp.names83 ? "yes" : "no");
    for(int i = 0; i < count; i++) {
        char out[NAME_MAX + 1];
        storedName(&tp, argv[4 + i], out);
        if(!out[0]) continue;
        struct stat st;
        if(fstatat(ddfd, out, &st, AT_SYMLINK_NOFOLLOW) == 0)
            printf("exists=%s\t%s\t%c\n", argv[4 + i], out, S_ISDIR(st.st_mode) ? 'd' : S_ISREG(st.st_mode) ? 'f' : 'o');
    }
}

/* ------------------------------------------------------------- options */

/* the Files page's settings (Config, Experimental), in CE_FILES_CONF:
   GEMDOS_WRITE=yes: write through ce-gemdosfs (big GEMDOS sectors, swapped images) */
static const char *confPath = "/data/ce-files.conf";

static int confYes(const char *key)
{
    FILE *f = fopen(confPath, "r");
    if(!f) return 0;
    char line[256];
    size_t kl = strlen(key);
    int yes = 0;
    while(fgets(line, sizeof(line), f))
        if(strncmp(line, key, kl) == 0 && line[kl] == '=') yes = strncmp(line + kl + 1, "yes", 3) == 0;
    fclose(f);
    return yes;
}

static void cmdOptions(void)
{
    printf("gemdosWrite=%s\n", confYes("GEMDOS_WRITE") ? "yes" : "no");
}

static void cmdOptionSet(const char *name, const char *value)
{
    if(strcmp(name, "gemdosWrite") != 0) die(E_BAD, "Unknown option.");
    if(strcmp(value, "yes") != 0 && strcmp(value, "no") != 0) die(E_BAD, "yes or no?");
    char tmp[PATH_MAX];
    snprintf(tmp, sizeof(tmp), "%s.new", confPath);
    FILE *f = fopen(tmp, "w");
    if(!f) die(E_REFUSED, "Can't save the setting: %s", strerror(errno));
    fprintf(f, "GEMDOS_WRITE=%s\n", value);
    if(fflush(f) != 0 || fsync(fileno(f)) != 0) { fclose(f); die(E_REFUSED, "Can't save the setting."); }
    fclose(f);
    if(rename(tmp, confPath) != 0) die(E_REFUSED, "Can't save the setting: %s", strerror(errno));
    /* images open on the Files page: closed, so the new mode applies when they're opened again */
    pid_t pid = fork();
    if(pid == 0) {
        int nul = open("/dev/null", O_RDWR);
        if(nul >= 0) { dup2(nul, 0); dup2(nul, 1); dup2(nul, 2); }
        execl(hdinspect, hdinspect, "close", (char *) NULL);
        _exit(127);
    }
    if(pid > 0) { int st; while(waitpid(pid, &st, 0) < 0 && errno == EINTR) { } }
    cmdOptions();
}

/* ------------------------------------------------------------- main */

int main(int argc, char **argv)
{
    if(getenv("CE_FILES_STORAGE")) storageRoot = getenv("CE_FILES_STORAGE");
    if(getenv("CE_FILES_MNT")) mntRoot = getenv("CE_FILES_MNT");
    if(getenv("CE_FILES_HDINSPECT")) hdinspect = getenv("CE_FILES_HDINSPECT");
    if(getenv("CE_FILES_RUN")) runDir = getenv("CE_FILES_RUN");
    if(getenv("CE_FILES_CONF")) confPath = getenv("CE_FILES_CONF");
    if(getenv("CE_FILES_SETTINGS")) settingsDir = getenv("CE_FILES_SETTINGS");
    umask(002);
    const char *cmd = argc > 1 ? argv[1] : "";
    if(strcmp(cmd, "places") == 0 && argc == 2) cmdPlaces();
    else if(strcmp(cmd, "ls") == 0 && argc == 4) cmdLs(argv[2], argv[3]);
    else if(strcmp(cmd, "cat") == 0 && (argc == 4 || argc == 5)) cmdCat(argv[2], argv[3], argc == 5 ? atoll(argv[4]) : -1);
    else if(strcmp(cmd, "job-start") == 0 && argc >= 9) cmdJobStart(argc, argv);
    else if(strcmp(cmd, "job-status") == 0 && argc == 2) cmdJobStatus();
    else if(strcmp(cmd, "options") == 0 && argc == 2) cmdOptions();
    else if(strcmp(cmd, "option-set") == 0 && argc == 4) cmdOptionSet(argv[2], argv[3]);
    else if(strcmp(cmd, "job-cancel") == 0 && argc == 2) cmdJobCancel();
    else if(strcmp(cmd, "conflicts") == 0 && argc >= 5) cmdConflicts(argc - 4, argv);
    else if(strcmp(cmd, "zip") == 0 && argc >= 5) cmdZip(argv[2], argv[3], argc - 4, argv + 4);
    else if(strcmp(cmd, "put") == 0 && (argc == 6 || argc == 7)) cmdPut(argv[2], argv[3], argv[4], argv[5], argc == 7 && strcmp(argv[6], "overwrite") == 0);
    else if(strcmp(cmd, "mkdir") == 0 && argc == 5) cmdMkdir(argv[2], argv[3], argv[4]);
    else if(strcmp(cmd, "rm") == 0 && argc >= 5) cmdRm(argv[2], argv[3], argc - 4, argv + 4);
    else if(strcmp(cmd, "rename") == 0 && argc == 6) cmdRename(argv[2], argv[3], argv[4], argv[5]);
    else if(strcmp(cmd, "fit83") == 0 && argc == 3) { char o[512]; fit83(argv[2], o); printf("%s\n", o); }
    else {
        fprintf(stderr, "usage: ce-files places | ls|cat <place> <path> [max] | zip <place> <dir> <name>... |\n"
                        "       job-start copy|move <from place> <dir> <to place> <dir> replace|skip <name>... | job-status | job-cancel |\n"
                        "       conflicts <place> <dir> <name>... |\n"
                        "       put <place> <dir> <name> <size> [overwrite] | mkdir <place> <dir> <name> |\n"
                        "       rm <place> <dir> <name>... | rename <place> <dir> <from> <to>\n");
        return E_BAD;
    }
    fflush(stdout);
    return 0;
}
