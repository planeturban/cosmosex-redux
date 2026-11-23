#!/bin/sh
# One-command build:
#   ./build.sh [variant] [target...]
#     variant: armv7 (default; Pi 2, 3, 3 B+), armv6 (Pi 1, 2, 3, 3 B+),
#              arm64 (Pi 3 / 3 B+, 64-bit, optional)
#     target:  none = the image, or e.g. menuconfig, linux-menuconfig,
#              ce-atari-rebuild
#   ./build.sh                 -> output-images/armv7/sdcard.img
#   ./build.sh arm64           -> output-images/arm64/sdcard.img
#   ./build.sh test            -> unit tests (tests/unit, on the build host)
# Runs inside the build container (see br.sh). Each variant has its own
# output directory in the Docker volume (/work/output-<variant>; arm64 keeps
# the original /work/output); the finished image is copied to
# ./output-images/<variant>/ on the host.
set -e
cd "$(dirname "$0")"
[ "$1" = test ] && exec ./br.sh sh /src/tests/unit/run.sh
VARIANT=armv7
case "$1" in
	armv7|armv6|arm64) VARIANT=$1; shift ;;
esac
[ -f configs/cosmosex_${VARIANT}_defconfig ] || { echo "no configs/cosmosex_${VARIANT}_defconfig"; exit 1; }
exec ./br.sh sh -c '
	set -e
	V=$1; shift
	O=/work/output-$V
	[ $V = arm64 ] && O=/work/output
	# our changes to Buildroot itself (package updates for security fixes,
	# buildroot-patches/): applied once, skipped when already in
	for p in /src/buildroot-patches/*.patch; do
		[ -f "$p" ] || continue
		git -C /work/buildroot apply --reverse --check "$p" 2>/dev/null && continue
		git -C /work/buildroot apply "$p" || { echo "buildroot patch failed: $p"; exit 1; }
		echo "applied $(basename "$p")"
	done
	make -C /work/buildroot O=$O BR2_EXTERNAL=/src cosmosex_${V}_defconfig > /dev/null
	# local packages: Buildroot copies their source only once, so changes
	# (webui/, the small C tools) would be missed; copying them is quick
	make -C $O ce-webui-dirclean ce-tryboot-dirclean ce-screensaver-dirclean ce-files-dirclean ce-gemdosfs-dirclean > /dev/null
	make -C $O "$@"
	eval "last=\${$#}"                     # (the image is copied out after a full build: no targets, or ... all)
	if { [ $# -eq 0 ] || [ "$last" = all ]; } && [ -f $O/images/sdcard.img ]; then
		mkdir -p /src/output-images/$V
		cp $O/images/sdcard.img $O/images/*.dtb /src/output-images/$V/
		cp $O/images/Image.gz $O/images/zImage /src/output-images/$V/ 2>/dev/null || true
		echo "Image: output-images/$V/sdcard.img"
		# root file system size over time (measured by post-image.sh)
		if [ -f $O/images/rootfs-usage.txt ]; then
			echo "$(date -u "+%Y-%m-%d %H:%M") $V $(cat $O/images/rootfs-usage.txt)" >> /src/output-images/rootfs-size.log
			cat $O/images/rootfs-usage.txt
		fi
	fi
' build "$VARIANT" "$@"
