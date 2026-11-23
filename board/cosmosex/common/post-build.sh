#!/bin/sh
# Runs after the target tree is assembled, before the rootfs image is made.
set -eu

TARGET_DIR="$1"

# Boot partition: read-only by default; the init script remounts it read-write
# only to update doflash.txt / doflash.log.
grep -q '^/dev/mmcblk0p1' "$TARGET_DIR/etc/fstab" || \
	echo '/dev/mmcblk0p1	/boot	vfat	ro,noatime	0	0' >> "$TARGET_DIR/etc/fstab"
# The app creates its mount points (/mnt/sda1, /mnt/shared, ...) itself
grep -q '[[:space:]]/mnt[[:space:]]' "$TARGET_DIR/etc/fstab" || \
	echo 'tmpfs		/mnt		tmpfs	mode=0755,nosuid,nodev	0	0' >> "$TARGET_DIR/etc/fstab"
mkdir -p "$TARGET_DIR/boot" "$TARGET_DIR/data" "$TARGET_DIR/storage"
# /pi was renamed /storage (2026-11-15): drop what earlier builds left in target/
rm -rf "$TARGET_DIR/pi" "$TARGET_DIR/usr/sbin/ce-pishare" "$TARGET_DIR/etc/ce-pishare.conf" "$TARGET_DIR/etc/init.d/S60pishare"

# read-only root. What changes at runtime lives on the data
# partition (/data), mounted by ce-preinit, which also creates missing /data
# directories from the skeleton below. The paths are relative symlinks into
# /data, so package installs on a rebuild land in $TARGET_DIR/data, not on
# the build host; those are swept into the skeleton here too.
SKEL="$TARGET_DIR/usr/share/ce-data-skel"
to_data() {	# <path in rootfs> <path in /data>
	src="$TARGET_DIR/$1"
	mkdir -p "$SKEL/$2"
	if [ -d "$src" ] && [ ! -L "$src" ]; then
		cp -a "$src/." "$SKEL/$2/"
		rm -rf "$src"
	fi
	if [ -d "$TARGET_DIR/data/$2" ]; then
		cp -a "$TARGET_DIR/data/$2/." "$SKEL/$2/"
	fi
	rm -f "$src"
	up=$(echo "$1" | sed 's|[^/]*/|../|g; s|[^/]*$||')
	ln -s "${up}data/$2" "$src"
}
to_data ce ce
to_data var/log log
to_data var/db var/db
to_data var/lib var/lib
to_data home home
to_data etc/dropbear ssh	# SSH host keys (kept by a factory reset)
# /data is only a mount point in the image. No SSH host keys in the skeleton:
# dropbear makes them on first start, unique per card.
rm -rf "$TARGET_DIR/data"/* "$SKEL/ssh"/*
# Buildroot's mkusers creates /home/<user> while making the image, so the
# /home link must resolve then (the real /data is mounted over this at boot).
# The same for packages installed on a later rebuild into the linked folders
# (dhcpcd 10.5 installs /var/db/dhcpcd): their targets exist, empty, and
# what lands there is swept into the skeleton by the next post-build.
mkdir -p "$TARGET_DIR/data/home" "$TARGET_DIR/data/var/db" "$TARGET_DIR/data/var/lib" \
	"$TARGET_DIR/data/log" "$TARGET_DIR/data/ce"

# Image identification, shown on the HDMI login banner (ce-issue) and in ce-report
# The app and chip flashers (package ce-atari) go into the /ce seed
# (package cosmosex) on every build: either package can be rebuilt on its
# own, and a rebuilt cosmosex package would otherwise lose them (happened
# 2026-11-15: an image without the app). Stop the build if one is missing.
CEA_DIR=$(ls -d "${BUILD_DIR}"/ce-atari-*/ 2>/dev/null | head -1)
SEED="${TARGET_DIR}/usr/share/cosmosex/ce"
for pair in ce_main_app/cosmosex_raspbian_stretch:app/cosmosex \
            flash_stm32/flash_stm32:update/flash_stm32 \
            flash_xilinx/flash_xilinx:update/flash_xilinx; do
	src="${CEA_DIR}${pair%%:*}"
	dst="${SEED}/${pair#*:}"
	if [ ! -f "$src" ]; then
		echo "post-build: missing $src (ce-atari not built?)" >&2
		exit 1
	fi
	install -D -m 0755 "$src" "$dst"
done

CE_VERSION=$(sed -n 's/^COSMOSEX_VERSION = //p' "$(dirname "$0")/../../../package/cosmosex/cosmosex.mk")
echo "Buildroot image $(date -u '+%Y-%m-%d'), ce-atari-releases stretch@$(echo "$CE_VERSION" | cut -c1-7)" \
	> "$TARGET_DIR/etc/cosmosex-release"

# Which image this is, for system updates (ce-sysupdate): the variant, and
# the version: "dev-<build time>" for your own builds (a published image
# gets its version written in when it is published)
if grep -q '^BR2_aarch64=y' "$BR2_CONFIG"; then variant=arm64
elif grep -q '^BR2_arm1176jzf_s=y' "$BR2_CONFIG"; then variant=armv6
else variant=armv7; fi
echo "$variant" > "$TARGET_DIR/etc/cosmosex-variant"
echo "dev-$(date -u '+%Y%m%d%H%M')" > "$TARGET_DIR/etc/cosmosex-version"

# No root password (an empty one in Buildroot means passwordless login): root
# is only reachable via sudo from user ce.
sed -i 's/^root:[^:]*:/root:*:/' "$TARGET_DIR/etc/shadow"

# ce: sudo without password (SSH is key-only; the key is the credential)
if ! grep -q '^ce ' "$TARGET_DIR/etc/sudoers"; then
	chmod u+w "$TARGET_DIR/etc/sudoers"
	echo 'ce ALL=(ALL:ALL) NOPASSWD: ALL' >> "$TARGET_DIR/etc/sudoers"
	chmod 0440 "$TARGET_DIR/etc/sudoers"
fi

# nfs-utils' own server and rpcbind init scripts: not used. The NFS client
# mounts with nolock (no rpcbind needed); the server for /storage is
# started by our /usr/sbin/ce-storageshare (S60storageshare), which starts rpcbind itself.
rm -f "$TARGET_DIR/etc/init.d/S60nfs" "$TARGET_DIR/etc/init.d/S30rpcbind"

# nginx: ours is S01nginx with our nginx.conf (the overlay); not the package's
# start script, sample pages, log rotation or the settings of modules left out
rm -f "$TARGET_DIR/etc/init.d/S50nginx" "$TARGET_DIR/etc/logrotate.d/nginx"
rm -rf "$TARGET_DIR/usr/html"
for f in "$TARGET_DIR"/etc/nginx/*; do
	case "$f" in */nginx.conf) ;; *) rm -f "$f" ;; esac
done

# autofs runs /usr/sbin/mount.nfs, util-linux mount looks for helpers in
# /sbin: make sure both find the NFS and CIFS helpers.
for h in mount.nfs mount.cifs; do
	for d in sbin usr/sbin; do
		if [ ! -e "$TARGET_DIR/$d/$h" ]; then
			for src in sbin usr/sbin; do
				if [ -e "$TARGET_DIR/$src/$h" ] && [ ! -L "$TARGET_DIR/$src/$h" ]; then
					ln -sf "/$src/$h" "$TARGET_DIR/$d/$h"
					break
				fi
			done
		fi
	done
done

# Wi-Fi. As on Raspbian, dhcpcd starts wpa_supplicant when wlan0 appears
# (its 10-wpa_supplicant hook, which Buildroot installs but doesn't enable).
# The app stops it again if Wi-Fi is disabled in the CosmosEx settings.
if [ -f "$TARGET_DIR/usr/share/dhcpcd/hooks/10-wpa_supplicant" ]; then
	install -m 0644 "$TARGET_DIR/usr/share/dhcpcd/hooks/10-wpa_supplicant" \
		"$TARGET_DIR/lib/dhcpcd/dhcpcd-hooks/10-wpa_supplicant"
fi
# The app's "ifup/ifdown wlan0" must not start BusyBox's udhcpc next to dhcpcd.
ln -sf /usr/libexec/ce-ifupdown "$TARGET_DIR/sbin/ifup"
ln -sf /usr/libexec/ce-ifupdown "$TARGET_DIR/sbin/ifdown"
# Keep only the firmware for the Pi 3 B (BCM43430) and 3 B+ (CYW43455). Most
# brcm/ files are symlinks into cypress/; drop links left dangling.
for f in "$TARGET_DIR"/lib/firmware/brcm/brcmfmac* "$TARGET_DIR"/lib/firmware/cypress/cyfmac*; do
	case "${f##*/}" in
		brcmfmac43430-sdio.bin|brcmfmac43430-sdio.clm_blob|brcmfmac43430-sdio.txt) ;;
		brcmfmac43430-sdio.raspberrypi,3-model-b.*) ;;
		brcmfmac43455-sdio.bin|brcmfmac43455-sdio.clm_blob|brcmfmac43455-sdio.txt) ;;
		brcmfmac43455-sdio.raspberrypi,3-model-b-plus.*) ;;
		cyfmac43430-sdio.*|cyfmac43455-sdio.*) ;;
		*) rm -f "$f" ;;
	esac
done
find "$TARGET_DIR/lib/firmware/brcm" -xtype l -delete 2>/dev/null || true

# nfs-utils' udev rule runs nfsrahead for every block device; it aborts on
# this system (udevd logs an error per device at boot) and only tunes NFS
# read-ahead, which the CosmosEx doesn't need.
rm -f "$TARGET_DIR/usr/lib/udev/rules.d/99-nfs.rules" "$TARGET_DIR/lib/udev/rules.d/99-nfs.rules"

# Media streaming: the app runs /usr/local/bin/ffmpeg (the stock image's path)
if [ -x "$TARGET_DIR/usr/bin/ffmpeg" ]; then
	mkdir -p "$TARGET_DIR/usr/local/bin"
	ln -sf ../../bin/ffmpeg "$TARGET_DIR/usr/local/bin/ffmpeg"
fi

# avahi: only our services (web interface, /storage over NFS), not the examples
rm -f "$TARGET_DIR/etc/avahi/services/ssh.service" "$TARGET_DIR/etc/avahi/services/sftp-ssh.service"
