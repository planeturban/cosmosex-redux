#!/bin/sh
# A loop device, RAM disk or device-mapper volume in /dev/disk/by-uuid isn't taken for a USB drive.
#
# The device finder (devfinder.cpp, the rest stubbed) with links as udev makes
# them for a loop device with a file system (losetup, a snap), a zram disk and
# an LVM volume. Stock: each is cut at its first digit ("/dev/loop", "/dev/dm-")
# and mounted as a USB drive that can't work: a dead translated drive on the ST.
# A real stick next to them is still found.
. "$(dirname "$0")/lib.sh"
D=/dev/disk

hbuild h_devfinder "$HERE/harness/h_devfinder.cpp" "$CE/devfinder.cpp" "$CE/utils.cpp" "$CE/debug.cpp"
out=$("$B/h_devfinder" \
	"mkdir -p $D/by-uuid $D/by-id; find $D -type l -delete" \
	"ln -s ../../loop3 $D/by-uuid/aaaa-0001; ln -s ../../zram0 $D/by-uuid/aaaa-0002; ln -s ../../dm-0 $D/by-uuid/aaaa-0003; ln -s ../../ram1 $D/by-uuid/aaaa-0004" \
	"ln -s ../../sdz1 $D/by-uuid/1234-ABCD; ln -s ../../sdz1 $D/by-id/usb-Test_Stick-part1" \
	scan \
	"find $D -type l -delete")
echo "$out" | sed 's/^/      | /'
expect "the loop device isn't mounted"        0 "$(echo "$out" | grep -c 'MOUNT /dev/loop')"
expect "the zram disk isn't mounted"          0 "$(echo "$out" | grep -c 'MOUNT /dev/zram')"
expect "the device-mapper volume isn't mounted" 0 "$(echo "$out" | grep -c 'MOUNT /dev/dm-')"
expect "the RAM disk isn't mounted"           0 "$(echo "$out" | grep -c 'MOUNT /dev/ram')"
expect "the USB stick is (as before)"         1 "$(echo "$out" | grep -c '^mounter: MOUNT /dev/sdz1 /mnt/sdz1$')"
expect "one translated drive in all"          1 "$(echo "$out" | grep -c '^translated: attach ')"
finish
