# CosmosEx redux

<img src="artwork/redux-logo-light.svg" alt="CosmosEx redux" width="410">

A small, purpose-built Linux image for the [CosmosEx](https://joo.kie.sk/?page_id=384) (Atari ST ACSI/SCSI/floppy emulator), built with Buildroot, replacing the stock Raspbian image, with a new web interface.

**It is all based on Jookie's work:** the CosmosEx hardware, its firmware and its software are his. The Raspberry Pi programs (the CosmosEx app, `flash_stm32`, `flash_xilinx`) are built from the [ce-atari](https://github.com/atarijookie/ce-atari) `master` branch with the patches in `package/ce-atari/`; the Atari-side programs, chip firmware and scripts come from the `stretch` branch of [ce-atari-releases](https://github.com/atarijookie/ce-atari-releases).

- **Images, demo and floppy library lists:** <https://redux.cosmosex.net>
- **User manual:** [docs/manual.md](docs/manual.md)

| Variant | Runs on | Config |
|---|---|---|
| `armv7` | Raspberry Pi 2, 3, 3 B+ | `configs/cosmosex_armv7_defconfig` |
| `armv6` | Raspberry Pi 1 (B, B+, A+), Zero / Zero W; also runs on the newer ones | `configs/cosmosex_armv6_defconfig` |
| `arm64` | Raspberry Pi 3 / 3 B+, 64-bit (optional) | `configs/cosmosex_arm64_defconfig` |

Tested on hardware: a Raspberry Pi 3 B+ (armv7) and a Raspberry Pi 1 Model B (armv6). The Pi 2 and the Zero have only been run in QEMU.

## Build

The build runs in a Docker container (Debian 12 with the usual build tools, `docker/Dockerfile`), so the host only needs Docker. Buildroot, the downloads and the build output live in a Docker volume, `cosmosex-br-work`; allow about 50 GB for all three variants.

**1. Docker.** On Linux, any Docker installation. On macOS, for example Colima: `brew install colima docker docker-buildx`, then once per login session:

```sh
colima start --cpu 6 --memory 10 --disk 100 --vm-type vz --mount-type virtiofs
```

**2. Buildroot, once.** Clone Buildroot 2026.02.3 into the volume (`br.sh` makes the container image and the volume the first time it is run):

```sh
./br.sh git clone --depth 1 -b 2026.02.3 https://gitlab.com/buildroot.org/buildroot.git /work/buildroot
```

**3. Build.**

```sh
./build.sh                     # ARMv7 (Pi 2, 3, 3 B+) → output-images/armv7/sdcard.img
./build.sh armv6               # Pi 1 / Zero → output-images/armv6/sdcard.img
./build.sh arm64               # 64-bit → output-images/arm64/sdcard.img
./build.sh test                # unit tests (tests/unit); after a build: they use its patched source
./build.sh armv7 linux-menuconfig   # any other Buildroot target works too
./br.sh                        # a shell inside the build container
```

`build.sh` applies `buildroot-patches/*.patch` to Buildroot (package updates for security fixes; once, skipped when already in), configures the variant and builds. The source of the CosmosEx app and its release files is downloaded from Jookie's repositories at pinned commits and patched with `package/ce-atari/*.patch` and `package/cosmosex/*.patch`.

Each variant has its own output directory in the volume (`/work/output-armv7`, `/work/output-armv6`; arm64 keeps `/work/output`). The first build of a variant takes about an hour (it builds its own toolchain); rebuilds after small changes take minutes. After changing a patch in `package/ce-atari/`, run `./build.sh <variant> ce-atari-dirclean` first. Your own builds call themselves `dev-<build time>`.

## Flash and test

Write `output-images/<variant>/sdcard.img` to an SD card (Raspberry Pi Imager, or `dd`). On a CosmosEx that already runs redux, upload the same `sdcard.img` under Config → Software & update instead (it must be the variant the CosmosEx runs). See the [manual](docs/manual.md) for the first start.

**Web interface:** edit `webui/` (plain HTML, CSS and ES-module JavaScript, no build step) and run `./build.sh <variant>`: the build always takes the current `webui/`. On a running system, changed files can also be copied into `/usr/share/cosmosex/webroot/` after `sudo ce-rw` (the root is read-only).

**Without hardware:** `./run-qemu.sh` boots a copy of the ARMv7 image in QEMU (`brew install qemu`), emulating a Raspberry Pi 2B (`./run-qemu.sh armv6`: a Pi Zero; `./run-qemu.sh arm64`: the 64-bit image on a Pi 3B). The window is the HDMI console; SSH with `ssh -p 2222 ce@localhost`, web UI at `http://localhost:8080/`. Good for boot, init scripts, banner, logins and SSH; the CosmosEx chips, the Pi 3 B+ network chips and boot timing can't be tested this way. `./run-qemu.sh keep` reuses the previous copy (after first boot). In QEMU the CosmosEx chips don't answer, and the app would quit every ~30 s and be restarted, dropping web requests meanwhile. So `run-qemu.sh` puts the app option `noreset` into `/ce/default_args` of the QEMU copy (via the build container, so Colima must be running): the app doesn't reset Hans and Franz at start and doesn't quit when they don't answer. Only the QEMU copy is changed, never `sdcard.img`. `CHIPCHECK=1 ./run-qemu.sh` boots with stock behaviour. Known QEMU issue: occasionally the kernel oopses in the SD card driver (`bcm2835_finish_data`) during boot, apparently when the Mac is busy (e.g. right after a build); boot again. It hasn't been seen on hardware, and booting the same image again works.

## Using the image

- **Login:** user `ce`, which has `sudo` without a password. There is no root login and no default password.
  - **SSH** is key-only: every `*.pub` file (and `authorized_keys`) in the root of the boot partition becomes `ce`'s key list at each boot. No key file, no SSH. Root and password logins are disabled (`dropbear -w -s`).
  - **HDMI console:** press Enter at the banner for a `ce` shell. After `sudo passwd ce`, the console asks for that password instead.
  - There is no serial console: the Pi's UART is wired to the CosmosEx chips.
- **Web interface (port 80):** asks for a password; the default is `thisisnotsecure` until you set your own under Config → Web login. It is plain HTTP: use it on networks you trust. The Atari-side config tool can open a root shell, which requires physical access to the Atari.
- **HDMI status banner:** above the login prompt: hostname, IP and web UI address, app status, chip firmware versions, mounted drives, free SD space, CPU temperature, under-voltage warning, time and uptime, boot timing (`ce-boottime --short`). Generated by `ce-issue` at boot, 15 s later, and on network changes (dhcpcd hook).
- **Diagnostics:** run `ce-report`. It writes `/tmp/ce-report.txt` and a copy to `ce-report.txt` on the boot partition.
- **Logs:** `/var/log/ceapp-init.log` (startup, seeding, recovery flash), `/var/log/ce.log` (the app), `/var/log/messages` (system).
- **Chip firmware:** on first boot the image records the shipped firmware as already flashed, instead of reflashing all chips as a fresh stock card does. Every CosmosEx in the field already has this firmware.
- **Recovery flash:** to reflash Xilinx, Hans and Franz, create an empty file `doflash.txt` on the boot partition (the `CosmosEx` volume on a PC/Mac) and boot. Afterwards it's renamed to `doflash.done`, and the flash output is in `doflash.log` on the same partition. If a flash is interrupted by power loss, it runs again on the next boot.

## SD card layout

| # | Partition | Type | Size | Contents |
|---|---|---|---|---|
| 1 | `boot` | FAT, label `CosmosEx` | 48 MB | firmware, kernel, DTB, `config.txt`, `cmdline.txt`, `*.pub`, `doflash.*`, `factoryreset.*`, `ce-report.txt`, `ce-recovery.txt`. Mounted read-only at `/boot`. |
| 2 | `rootA` | ext4 | 128 MB | the system, mounted **read-only** |
| 3 | `rootB` | — | 128 MB | the other system (A/B updates, `ce-sysupdate`) |
| 4 | extended | | rest | holds 5 and 6; created on first boot |
| 5 | `data` | ext4 | 128 MB | created on first boot. `/data`: `/ce`, `/etc` overlay upper, `/var/log`, `/var/db`, `/var/lib`, `/home`, SSH host keys, saved clock |
| 6 | `storage` | ext4 | rest of card | `/storage`, created on first boot by `ce-preinit` |

`sdcard.img` holds only partitions 1 and 2 (≈ 180 MB, quick to write; fits a 1 GB card with about 500 MB left for /storage); 3 is a table entry only. The kernel starts `/sbin/ce-preinit` (`init=` in `cmdline.txt`), which on first boot creates partitions 4–6, then checks and mounts `/data` and `/storage`, mounts the `/etc` overlay, then starts BusyBox init. `/ce`, `/var/log`, `/var/db`, `/var/lib`, `/home` and `/etc/dropbear` are symlinks into `/data`; missing `/data` directories are created from `/usr/share/ce-data-skel`. `sudo ce-rw` / `ce-ro` remount the root for debugging.

## Tree

| Path | Purpose |
|---|---|
| `configs/cosmosex_<variant>_defconfig` | Buildroot configurations (armv7, armv6, arm64) |
| `package/ce-atari/` | builds the CosmosEx app and chip flashers from the pinned ce-atari source, plus our patches |
| `package/cosmosex/` | installs the pinned ce-atari-releases commit (minus its 32-bit binaries) as the `/ce` seed, plus our patch |
| `webui/` | the web interface: plain HTML, one CSS file, ES-module JavaScript, no build step |
| `package/ce-webui/`, `package/ce-webui-fonts/` | install the web UI to `/usr/share/cosmosex/webroot` (the app serves it from there, ce-atari patch 0008), on top of the release's classic pages; the fonts are downloaded at build time |
| `package/ce-screensaver/` | HDMI screen saver (C, framebuffer): spinning, bouncing Atari logo after 5 min idle, HDMI off after 30 min; wakes on console input and on USB input reported by the app (`/api/v1/status`) |
| `tools/gen-timezones.py`, `tools/genlogo.py`, `tools/m68k/` | make files that are in the tree: the web interface's time zone list, the screen saver's logo data, and the ST-side driver `CE_DD.PRG` (m68k cross compiler in Docker) |
| `tests/unit/` | unit tests of app code that needs no hardware (`./build.sh test`) |
| `board/cosmosex/common/` | shared by all variants: `cmdline.txt`, kernel config fragment, users table, image layout, post-build/post-image scripts |
| `board/cosmosex/armv7/`, `board/cosmosex/arm64/` | per variant: `config.txt` and kernel config (`linux.defconfig`; arm64's trimmed to the modules the CosmosEx uses, see `linux.defconfig.README`) |
| `board/cosmosex/common/rootfs-overlay/` | `ce-preinit` (storage setup), `ce-housekeeping` + `S03housekeeping` (log rotation, clock), `ce-rw`/`ce-ro`, `S95screensaver` + `/etc/default/ce-screensaver`, init scripts `S00ceapp`, `S41dhcpcd` (backgrounded), `S49cesshkeys` and `S99ceissue`, `ce-boottime`, `ce-console-login`, dropbear options, Wi-Fi config and the `ifup`/`ifdown` wrapper `ce-ifupdown`, `/dev/serial0` udev rule, `lsb_release` shim, `ce-report`, `ce-issue` (HDMI banner) + its dhcpcd hook |
| `run-qemu.sh` | boot an image in QEMU: `./run-qemu.sh [armv7|arm64] [keep]`; `USBSTICK=1` adds a USB stick, `HEADLESS=1` runs without a window |
| `docs/upstream-patches.md` | every patch carried and upstream issues found, for sending back to the ce-atari author |
| `upstream/` | the patches meant for ce-atari as they are (`patches/`), with tests (`tests/`) |
| `artwork/` | the logo |
| `docs/manual.md` | user manual: installing, settings, boot-partition files, troubleshooting |
| `docs/imagelist-format.md`, `docs/imagelist.schema.json` | the extended floppy library list format |

## Known gaps

- SMB1-only CIFS servers and NFS servers given by hostname don't work (same as stock).
- Writing to GEMDOS partitions with big sectors or very few clusters from the Files page is experimental and off by default.

## Credits and licence

The CosmosEx, its firmware and its software are by Jookie: <https://joo.kie.sk/?page_id=384>. His app, `ce_main_app` in [ce-atari](https://github.com/atarijookie/ce-atari), is under a BSD 2-clause licence (`ce_main_app/license.txt` there); his release files ([ce-atari-releases](https://github.com/atarijookie/ce-atari-releases/tree/stretch)) are under the GNU General Public License, version 3. The files in `package/ce-atari/*.patch`, `package/cosmosex/*.patch` and `upstream/patches/` are changes to his code, which remains his.

Everything else here (the Buildroot external tree, the scripts, the web interface in `webui/`, the tools and tests) is licensed to match, under the GNU General Public License, version 3 or (at your option) any later version: see [LICENSE](LICENSE). The web fonts (Barlow, Barlow Condensed, JetBrains Mono) are under the SIL Open Font License: `webui/fonts/LICENSE-*`. The floppy library's game pictures come from [Atari Legend](https://www.atarilegend.com/) (CC BY-NC-SA) and Wikipedia.
