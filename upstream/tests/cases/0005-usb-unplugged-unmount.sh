#!/bin/sh
# A USB drive that's pulled out is unmounted, not only detached from the ST.
#
# 1. The device finder (devfinder.cpp, the rest stubbed): a stick appears in
#    /dev/disk, then goes away -> the mounter is asked to unmount /mnt/<part>.
#    Stock: it's only detached from the translated drives; /mnt/sdz1 stays
#    mounted, so the next stick becomes sdb, sdc ... until a reboot.
# 2. The mounter (mounter.cpp, real mounts): a mount with a file still open on
#    it (the pulled-out stick, in use) is unmounted anyway (lazily).
#    Stock: umount fails with "busy" and the mount stays for good.
. "$(dirname "$0")/lib.sh"
D=/dev/disk

hbuild h_devfinder "$HERE/harness/h_devfinder.cpp" "$CE/devfinder.cpp" "$CE/utils.cpp" "$CE/debug.cpp"
out=$("$B/h_devfinder" \
	"mkdir -p $D/by-uuid $D/by-id; find $D -type l -delete" \
	"ln -s ../../sdz1 $D/by-uuid/1234-ABCD; ln -s ../../sdz $D/by-id/usb-Test_Stick; ln -s ../../sdz1 $D/by-id/usb-Test_Stick-part1" \
	scan \
	"find $D -type l -delete" \
	scan)
echo "$out" | sed 's/^/      | /'
plugged=$(echo "$out" | awk '/^-- scan/ { n++; next } n == 1')
pulled=$(echo "$out" | awk '/^-- scan/ { n++; next } n == 2')
expect "plugged in: mounted at /mnt/sdz1"            1 "$(echo "$plugged" | grep -c '^mounter: MOUNT /dev/sdz1 /mnt/sdz1$')"
expect "plugged in: a translated drive"              1 "$(echo "$plugged" | grep -c '^translated: attach /mnt/sdz1 ')"
expect "pulled out: detached from the ST"            1 "$(echo "$pulled" | grep -c '^translated: detach /mnt/sdz1$')"
expect "pulled out: the mounter asked to unmount it" 1 "$(echo "$pulled" | grep -c '^mounter: UMOUNT .*/mnt/sdz1$')"

hbuild h_mounter "$HERE/harness/h_mounter.cpp" "$CE/mounter.cpp" "$CE/utils.cpp" "$CE/debug.cpp"
if ! "$B/h_mounter" can-mount; then
	echo "    (no right to mount in this container: the busy-unmount part not run)"
else
	out=$("$B/h_mounter" unmount-busy)
	echo "$out" | sed 's/^/      | /'
	expect "in use: unmounted all the same"             "gone" "$(echo "$out" | sed -n 's/^after: //p')"
	out=$("$B/h_mounter" unmount-idle)
	expect "not in use: unmounted (as before)"          "gone" "$(echo "$out" | sed -n 's/^after: //p')"
fi
finish
