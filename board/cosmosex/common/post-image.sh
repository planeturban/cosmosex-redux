#!/bin/bash
# Builds sdcard.img with genimage. Based on Buildroot's
# board/raspberrypi/post-image.sh.
set -e

BOARD_DIR="$(dirname "$0")"     # board/cosmosex/common
GENIMAGE_CFG="${BINARIES_DIR}/genimage.cfg"
GENIMAGE_TMP="${BUILD_DIR}/genimage.tmp"

# Always use the current cmdline.txt and config.txt: Buildroot copies them only
# when the rpi-firmware package is (re)built, so an edit alone wouldn't reach
# the image (init=/sbin/ce-preinit was lost that way once).
# The files the defconfig names (each build variant has its own config.txt).
cfg_file() {
	sed -n "s/^$1=\"\(.*\)\"$/\1/p" "${BR2_CONFIG}" |
		sed "s|\$(BR2_EXTERNAL_COSMOSEX_PATH)|${BR2_EXTERNAL_COSMOSEX_PATH}|"
}
cp "$(cfg_file BR2_PACKAGE_RPI_FIRMWARE_CMDLINE_FILE)" "${BINARIES_DIR}/rpi-firmware/cmdline.txt"
cp "$(cfg_file BR2_PACKAGE_RPI_FIRMWARE_CONFIG_FILE)" "${BINARIES_DIR}/rpi-firmware/config.txt"

# Our own files for the boot partition (hostname.txt.example ...)
cp "${BOARD_DIR}"/boot-files/* "${BINARIES_DIR}/rpi-firmware/"

FILES=()
for i in "${BINARIES_DIR}"/*.dtb "${BINARIES_DIR}"/rpi-firmware/*; do
	FILES+=( "${i#${BINARIES_DIR}/}" )
done
KERNEL=$(sed -n 's/^kernel=//p' "${BINARIES_DIR}/rpi-firmware/config.txt")
FILES+=( "${KERNEL}" )

BOOT_FILES=$(printf '\\t\\t\\t"%s",\\n' "${FILES[@]}")
sed "s|#BOOT_FILES#|${BOOT_FILES}|" "${BOARD_DIR}/genimage.cfg.in" > "${GENIMAGE_CFG}"

trap 'rm -rf "${ROOTPATH_TMP}"' EXIT
ROOTPATH_TMP="$(mktemp -d)"
rm -rf "${GENIMAGE_TMP}"

genimage \
	--rootpath "${ROOTPATH_TMP}" \
	--tmppath "${GENIMAGE_TMP}" \
	--inputpath "${BINARIES_DIR}" \
	--outputpath "${BINARIES_DIR}" \
	--config "${GENIMAGE_CFG}"

# Cut the image off after rootA (partition 2). Partition 3 (rootB, empty)
# stays in the partition table beyond the end of the file; partitions 4-6 are
# made on the card by ce-preinit on first boot. Only boot + system get written
# when imaging a card. MBR entry n: offset 446 + 16 * (n - 1); start sector
# at +8, size at +12 (32-bit little-endian).
IMG="${BINARIES_DIR}/sdcard.img"
read -r p2_start p2_size <<<"$(od -An -tu4 -j $((446 + 16 + 8)) -N 8 "${IMG}")"
truncate -s $(( (p2_start + p2_size) * 512 )) "${IMG}"
echo "sdcard.img: $(( $(stat -c %s "${IMG}") / 1048576 )) MB (partitions 1-2; 3-6 are made on the card)"

# How full the root file system is (its partition is fixed: 128 MB since
# 2026-11-15, and cards in use can't grow it). Reported on every build, in
# rootfs-usage.txt for build.sh's history (output-images/rootfs-size.log); a warning
# from 80 %. (mkfs itself fails when the files don't fit at all.)
dumpe2fs=$(ls "${HOST_DIR}"/sbin/dumpe2fs "${HOST_DIR}"/bin/dumpe2fs 2>/dev/null | head -1)
if [ -n "$dumpe2fs" ]; then
	info=$("$dumpe2fs" -h "${BINARIES_DIR}/rootfs.ext4" 2>/dev/null)
	bsize=$(echo "$info" | sed -n 's/^Block size: *//p')
	blocks=$(echo "$info" | sed -n 's/^Block count: *//p')
	free=$(echo "$info" | sed -n 's/^Free blocks: *//p')
	used_kb=$(( (blocks - free) * bsize / 1024 )); total_kb=$(( blocks * bsize / 1024 ))
	pct=$(( used_kb * 100 / total_kb ))
	files_kb=$(du -sk "${TARGET_DIR}" | cut -f1)
	echo "rootfs: ${used_kb} KB used of ${total_kb} KB (${pct} %), files ${files_kb} KB" | tee "${BINARIES_DIR}/rootfs-usage.txt"
	[ "$pct" -ge 80 ] && echo "WARNING: the root file system is ${pct} % full (partition: $((total_kb / 1024)) MB)" >&2
fi
true
