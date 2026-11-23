/* Restart with an argument for the Raspberry Pi firmware driver:
   ce-tryboot "0 tryboot"  -> the next boot reads tryboot.txt, once.
   (BusyBox reboot can't pass an argument; the kernel's raspberrypi firmware
   driver turns " tryboot" into the firmware's one-shot flag.) */
#include <stdio.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <linux/reboot.h>
int main(int argc, char **argv)
{
    const char *arg = argc > 1 ? argv[1] : "0 tryboot";
    sync();
    if (syscall(SYS_reboot, LINUX_REBOOT_MAGIC1, LINUX_REBOOT_MAGIC2, LINUX_REBOOT_CMD_RESTART2, arg) < 0) {
        perror("reboot");
        return 1;
    }
    return 0;
}
