#!/bin/sh
# Boot a built image in QEMU.
#
#   ./run-qemu.sh [variant] [keep]
#     variant: armv7 (default; QEMU's Raspberry Pi 2B, 32-bit),
#              armv6 (QEMU's Raspberry Pi Zero, 32-bit) or
#              arm64 (QEMU's Raspberry Pi 3B, 64-bit)
#     keep:    boot the existing copy again (keeps first-boot state)
#   CHIPCHECK=1 ./run-qemu.sh   don't add "noreset" (see below)
#   HEADLESS=1 ./run-qemu.sh    no window; QEMU monitor on output-images/qemu-monitor.sock
#   CARD_MB=1024 ./run-qemu.sh  a card of that size (a power of two; default: 2 GB or more)
#   USBSTICK=1 ./run-qemu.sh    plus a 64 MB FAT USB stick (serial CE0001TEST),
#                               output-images/qemu-usbstick.img, kept between runs
#
# The window shows the HDMI console. Kernel messages (and the app's IKBD
# output) also go to output-images/qemu-serial.log. Networking is QEMU user
# mode over an emulated USB network adapter:
#   ssh -p 2222 ce@localhost        web UI: http://localhost:8080/   SMB: localhost port 4450
# The host is 10.0.2.2 from inside (e.g. a floppy library served there:
# http://10.0.2.2:8090/imagelist.csv).
# The CosmosEx chips aren't emulated, so the app runs but logs hardware errors.
# Without them the app would quit every ~30 s ("No answer from Hans or Franz")
# and be restarted, dropping web requests meanwhile. So a fresh copy gets the
# app option "noreset" in /ce/default_args: don't reset Hans and Franz at
# start, and don't quit when they don't answer. Only the QEMU copy is changed;
# needs the build container (Colima running).
set -e
cd "$(dirname "$0")/output-images"

VARIANT=armv7
case "$1" in armv7|armv6|arm64) VARIANT=$1; shift ;; esac
KEEP=$1

case $VARIANT in
arm64)
	QEMU=qemu-system-aarch64; MACHINE=raspi3b; KERNEL=Image.gz; DTB=bcm2710-rpi-3-b.dtb
	BROUT=/work/output ;;
armv7)
	QEMU=qemu-system-arm; MACHINE=raspi2b; KERNEL=zImage; DTB=bcm2709-rpi-2-b.dtb
	BROUT=/work/output-armv7 ;;
armv6)
	# QEMU's BCM2835 models don't emulate the power management block: the
	# kernel's power-domain driver dies on it (external abort), so it's
	# left out here (real Pi 1 / Zero hardware has it)
	QEMU=qemu-system-arm; MACHINE=raspi0; KERNEL=zImage; DTB=bcm2708-rpi-zero.dtb
	EXTRA_APPEND="initcall_blacklist=bcm2835_power_driver_init"
	BROUT=/work/output-armv6 ;;
esac

IMG=$VARIANT/sdcard.img
DISK=qemu-sdcard-$VARIANT.img

[ -f "$IMG" ] || { echo "No $IMG - run ./build.sh $VARIANT first"; exit 1; }
[ -f "$VARIANT/$DTB" ] || { echo "No $VARIANT/$DTB - rebuild with the current defconfig"; exit 1; }

if [ "$KEEP" != keep ] || [ ! -f "$DISK" ]; then
	cp "$IMG" "$DISK"
	# QEMU's SD card model needs a power-of-two size; at least 2 GB like a
	# real card (the image ends after partition 2, the rest is made on boot)
	size=$(stat -f %z "$DISK")
	pow=$(( ${CARD_MB:-2048} * 1048576 ))
	while [ $pow -lt "$size" ]; do pow=$((pow * 2)); done
	qemu-img resize -q -f raw "$DISK" "$pow"

	# SSH key for tests, if there is one (tools/.qemu-key and tools/.qemu-key.pub: an SSH key pair of your own)
	if [ -f ../tools/.qemu-key.pub ]; then
		cp ../tools/.qemu-key.pub qemu-test.pub
		bstart=$(fdisk -d "$DISK" | sed -n 1p | cut -d, -f1)
		../br.sh sh -c "$BROUT/host/bin/mcopy -o -i /src/output-images/$DISK@@$((bstart * 512)) /src/output-images/qemu-test.pub ::qemu-test.pub" >/dev/null 2>&1 || true
		rm -f qemu-test.pub
	fi

	if [ -z "$CHIPCHECK" ]; then
		# Put default_args into the /ce seed on the root partition (partition 2)
		# of the copy; S00ceapp copies the seed to /ce (data partition) on first boot
		echo noreset > qemu-default_args
		start=$(fdisk -d "$DISK" | sed -n 2p | cut -d, -f1)
		../br.sh sh -c "$BROUT/host/sbin/debugfs -w \
			-R 'write /src/output-images/qemu-default_args /usr/share/cosmosex/ce/default_args' \
			'/src/output-images/$DISK?offset=$((start * 512))'" >/dev/null 2>&1 \
			&& echo "QEMU copy: app started with 'noreset' (no chip check)" \
			|| echo "Warning: couldn't set 'noreset'; the app will restart every ~30 s"
		rm -f qemu-default_args
	fi
fi

USB_OPTS=
if [ -n "$USBSTICK" ]; then
	if [ ! -f qemu-usbstick.img ]; then
		# MBR with one FAT32 partition from 1 MB, formatted with mtools
		python3 -c "
import struct
size = 64 * 1024 * 1024
start, count = 2048, size // 512 - 2048
mbr = bytearray(512)
mbr[446:462] = struct.pack('<B3sB3sII', 0, b'\\0\\0\\0', 0x0c, b'\\0\\0\\0', start, count)
mbr[510:512] = b'\\x55\\xaa'
with open('qemu-usbstick.img', 'wb') as f:
    f.write(mbr); f.truncate(size)
"
		../br.sh sh -c "$BROUT/host/bin/mformat -i /src/output-images/qemu-usbstick.img@@1M -F -v CESTICK ::" >/dev/null
	fi
	USB_OPTS="-drive if=none,id=stick,format=raw,file=qemu-usbstick.img -device usb-storage,drive=stick,serial=CE0001TEST"
fi

DISPLAY_OPTS=
if [ -n "$HEADLESS" ]; then
	rm -f qemu-monitor.sock
	DISPLAY_OPTS="-display none -monitor unix:qemu-monitor.sock,server,nowait"
fi

# Kernel command line: the image's own cmdline.txt (as the Pi firmware passes
# it), plus options QEMU's USB emulation needs.
exec $QEMU \
	-M $MACHINE \
	-kernel $VARIANT/$KERNEL \
	-dtb $VARIANT/$DTB \
	-drive file="$DISK",if=sd,format=raw \
	-append "$(cat ../board/cosmosex/common/cmdline.txt) dwc_otg.fiq_enable=0 dwc_otg.fiq_fsm_enable=0 ${EXTRA_APPEND:-}" \
	-serial file:qemu-serial.log \
	-usb -device usb-kbd -device usb-tablet \
	-device usb-net,netdev=net0 \
	$USB_OPTS \
	$DISPLAY_OPTS \
	-netdev user,id=net0,hostfwd=tcp::2222-:22,hostfwd=tcp::8080-:80,hostfwd=tcp::4450-:445
