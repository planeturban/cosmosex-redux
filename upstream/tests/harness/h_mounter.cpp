// The tree's mounter.cpp.
//
//   h_mounter nfs-options <host> <dir>   Mounter::mountShared() for an NFS share,
//                                        with mount(2) replaced: prints what the
//                                        kernel would have been asked for
//   h_mounter can-mount                  exit 0 when this process may mount
//   h_mounter unmount-busy               a real tmpfs mount with a file open on
//                                        it, then Mounter::tryUnmount()
//   h_mounter unmount-idle               the same with nothing open
#include "common.h"
#include <fcntl.h>
#include <sys/syscall.h>
#include "mounter.h"

#define MNT "/tmp/h_mounter_mnt"

static bool fakeMount = false;

// mount(2), in front of the C library's
extern "C" int mount(const char *source, const char *target, const char *type, unsigned long mountflags, const void *data)
{
    if(fakeMount) {
        printf("mount: type=%s source=%s target=%s options=%s\n", type, source, target, (const char *) data);
        return 0;
    }
    return syscall(SYS_mount, source, target, type, mountflags, data);
}

static bool mounted(void)
{
    FILE *f = fopen("/proc/mounts", "r");
    char line[1024];
    bool found = false;
    while(f && fgets(line, sizeof(line), f)) {
        if(strstr(line, " " MNT " ")) found = true;
    }
    if(f) fclose(f);
    return found;
}

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    harnessLog("/tmp/h_mounter.log");
    const char *what = argc > 1 ? argv[1] : "";
    Mounter m;

    if(strcmp(what, "nfs-options") == 0 && argc > 3) {
        fakeMount = true;
        bool res = m.mountShared(argv[2], argv[3], true, "/tmp/h_mounter_shared", "", "");
        printf("mountShared: %s\n", res ? "true" : "false");
        return 0;
    }

    mkdir(MNT, 0755);
    if(strcmp(what, "can-mount") == 0) {
        if(mount("none", MNT, "tmpfs", 0, "size=1m") != 0) return 1;
        umount(MNT);
        return 0;
    }

    if(strcmp(what, "unmount-busy") == 0 || strcmp(what, "unmount-idle") == 0) {
        if(mount("none", MNT, "tmpfs", 0, "size=1m") != 0) { perror("mount"); return 99; }
        int fd = -1;
        if(strcmp(what, "unmount-busy") == 0) {
            fd = open(MNT "/open.file", O_CREAT | O_RDWR, 0644);    // someone still has a file open there
            if(fd < 0) { perror("open"); return 99; }
        }
        printf("before: %s\n", mounted() ? "mounted" : "gone");
        bool res = m.tryUnmount(MNT);
        printf("tryUnmount: %s\n", res ? "true" : "false");
        printf("after: %s\n", mounted() ? "still mounted" : "gone");
        if(fd >= 0) close(fd);
        if(mounted()) umount2(MNT, MNT_DETACH);     // tidy up after a stock run
        return 0;
    }

    fprintf(stderr, "usage: see the top of h_mounter.cpp\n");
    return 99;
}
