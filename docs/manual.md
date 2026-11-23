# CosmosEx redux — User manual

This image replaces the stock Raspbian system on the SD card of a CosmosEx (Atari ST ACSI/SCSI/floppy emulator with a Raspberry Pi 3 B+). It runs the same CosmosEx software as the stock image (the final `stretch` release), so the CosmosEx works the same from the Atari. The difference is the Linux system underneath: smaller, faster to boot, and locked down.

## Contents

1. [Installing](#1-installing)
2. [The boot partition: settings from your PC](#2-the-boot-partition-settings-from-your-pc)
3. [The HDMI screen](#3-the-hdmi-screen)
4. [Logging in](#4-logging-in)
5. [Configuring the CosmosEx](#5-configuring-the-cosmosex)
6. [The web interface](#6-the-web-interface)
7. [Updates and chip firmware](#7-updates-and-chip-firmware)
8. [Troubleshooting](#8-troubleshooting)
9. [Advanced settings](#9-advanced-settings)
10. [Security](#10-security)

---

## 1. Installing

**You need:** a microSD card (1 GB or larger; everything beyond about 430 MB becomes your `/storage` storage), a computer with a card reader, and the image file `sdcard.img`. Keep your stock CosmosEx card as a backup; this image doesn't need anything from it.

1. **Write the image** to the card with [Raspberry Pi Imager](https://www.raspberrypi.com/software/) (Choose OS → Use custom → `sdcard.img`). Skip Imager's "OS customisation"; it doesn't apply to this image. Any other image writer (`dd`, balenaEtcher) works too.
2. **Before first boot, add your SSH key** if you want network access to the Linux system (most users don't need it): copy your public key file (e.g. `id_ed25519.pub`) to the card's `CosmosEx` volume. See [Logging in](#4-logging-in).
3. **Put the card in the CosmosEx and power on.**

On first boot the system prepares itself and starts the CosmosEx software, which takes longer than later boots: it creates the `/storage` storage area on the rest of the card (a few seconds to about half a minute, depending on the card), and the settings area. The image itself is only about 180 MB, so writing it to the card is quick. A 1 GB card is enough (about 500 MB is left for /storage); bigger cards give more. Pulling the power during this is safe; it's finished on the next boot. Your chips (Hans, Franz, Xilinx) are **not** reflashed: the image assumes they already have the final firmware, which every CosmosEx in the field does. A fresh stock card, in contrast, reflashes all chips on first boot.

Your CosmosEx settings start at the defaults (ACSI ID 1 as translated drive, first translated drive `C:`, shared drive `P:`, config drive `O:`). Settings on your stock card are not copied over.

## 2. The boot partition: settings from your PC

The SD card's first partition is a normal FAT volume called `CosmosEx` that any PC or Mac can open. These files on it control the system:

| File | You create it to… | What happens |
|---|---|---|
| `*.pub` (e.g. `id_ed25519.pub`) or `authorized_keys` | allow SSH logins | At every boot all keys found become the SSH keys of user `ce`. Delete the file to revoke the key. |
| `doflash.txt` (empty file) | reflash the chips, e.g. after a failed update or if something broke | Next boot reflashes Xilinx, Hans and Franz with the firmware shipped in the image (takes a few minutes; don't power off). Afterwards the file is renamed to `doflash.done`, and the output is in `doflash.log`. If power is lost during flashing, it runs again on the next boot. |
| `factoryreset.txt` (empty file) | reset the CosmosEx to factory settings, e.g. if a setting made it unreachable | Next boot deletes all CosmosEx settings, network and Wi-Fi settings, the console password and the logs. Kept: your files in `/storage`, SSH keys on this volume, and the system's SSH identity. Afterwards the file is renamed to `factoryreset.done`. |
| `devmode.txt` | reach the app without nginx | An empty file. The app's own web server then also answers at `http://<ip-address>:8081/` (see [The web server](#the-web-server)). Delete the file to switch it off. |
| `hostname.txt` | name this CosmosEx on the network | One line with the name (letters, digits, `-`), e.g. `cosmosex-studio`; lines starting with `#` are ignored. The card comes with `hostname.txt.example`: change the name in it and rename it to `hostname.txt`. Used at the next boot, then renamed to `hostname.done`. The CosmosEx is then `cosmosex-studio.local` in a browser. Without it, each CosmosEx is named `cosmosex-XXXX` (from the Pi's serial number). |

These files are written by the system for you to read:

| File | Contents |
|---|---|
| `ce-report.txt` | diagnostics, written when someone runs `ce-report` (see [Troubleshooting](#8-troubleshooting)) |
| `doflash.log`, `doflash.done` | result of the last recovery flash |
| `ce-recovery.txt` | only if something went wrong at boot: the settings partition had to be recreated, or `/storage` couldn't be mounted (your files there are never deleted automatically) |

The other files on the `CosmosEx` volume are the Raspberry Pi firmware, Linux kernel and boot configuration. Leave `config.txt` and `cmdline.txt` alone unless you know what you're doing; see [Advanced settings](#9-advanced-settings).

The system keeps the `CosmosEx` volume read-only while running and only writes to it for a moment, so pulling the power doesn't damage it.

## 3. The HDMI screen

With a screen connected to the Pi's HDMI port, the CosmosEx shows a status screen with a rainbow Atari logo:

- **Hostname, network:** IP address of Ethernet and Wi-Fi, or "no link" / "waiting for DHCP".
- **Web UI and SSH addresses** to type into your browser or terminal.
- **App:** whether the CosmosEx software is running.
- **Chip FW:** firmware versions of Hans, Franz and Xilinx.
- **Drives:** USB drives and network shares currently mounted.
- **Settings, /storage:** free space on the settings partition and in your `/storage` storage, and lines starting with `!` for anything special on this boot (`/storage` set up, factory reset, a repaired problem).
- **SSH keys:** how many are installed for user `ce`.
- **CPU temperature** and **power**: shows "UNDER-VOLTAGE detected" if the power supply is too weak, a common cause of strange CosmosEx problems.
- **Time and uptime.** Time is local: in the **time zone** chosen under Config > Clock & screen (shown as e.g. `CET` or `CEST`), or UTC plus the fixed **UTC offset** set there (shown as e.g. `UTC+1`; plain UTC while neither is set). The CosmosEx sets the clock from the internet shortly after the network comes up.
- **Boot:** how many seconds after the Linux kernel started the boot was done, and the CosmosEx software was running (plus "ready", when Hans and Franz answered, if debug logging is on). Run `ce-boottime` for the full breakdown. The Raspberry Pi firmware's own start-up, before the kernel, comes on top; Linux can't measure it.

**Screen saver:** after 5 minutes without activity, a rainbow Atari logo spins and bounces around the screen; after 30 minutes the HDMI signal is switched off, so the monitor can go to standby. Activity means a key press or mouse movement on the Pi's keyboard/mouse, including while you use them on the Atari; the status screen comes back within a second. To change the times: `sudo vi /etc/default/ce-screensaver` (`-l` logo, `-o` off, in seconds; `0` = never), then reboot. A factory reset restores the defaults.

The screen updates by itself about 15 seconds after boot and whenever the network connection changes. A screen is not required; the CosmosEx works without one.

## 4. Logging in

You don't need to log in to use the CosmosEx. Logging in to Linux is for troubleshooting and advanced settings.

There is one login user, **`ce`**. It can run administrator commands with `sudo`. There is **no root login and no default password** anywhere in the image.

### SSH (over the network)

1. Copy your SSH public key (e.g. `~/.ssh/id_ed25519.pub` on Mac/Linux) to the `CosmosEx` volume. No key yet? Create one with `ssh-keygen -t ed25519`.
2. Boot the CosmosEx, then connect: `ssh ce@<ip-address>` (the address is on the HDMI screen, or in your router's list of devices as `cosmosex`).

SSH only accepts keys. Password logins and root logins are always refused.

### HDMI console (with a USB keyboard on the Pi)

A USB keyboard plugged into the Pi types on the **Atari** (the CosmosEx IKBD feature): the CosmosEx software takes it over, so the console doesn't see your keys. To use it on the HDMI console, press **Left Ctrl + Left Alt + Right Ctrl + Right Alt** together; the same combination gives it back to the Atari. (The status screen says so too, as the stock image's login message did.)

At the status screen, press **Enter** to get a shell as `ce`. No password is needed by default, since anyone at the screen has physical access to the device anyway.

To require a password on the console, log in and run `sudo passwd ce`. From then on, the console shows a normal login prompt. SSH stays key-only either way.


## 5. Configuring the CosmosEx

The CosmosEx settings are the same as on the stock image. You can change them in three places, which all show the same configuration screens:

- **On the Atari:** run `CE_CONF.TOS` from the config drive (`O:` by default).
- **In a browser:** open the web interface and choose **Configuration** (see [The web interface](#6-the-web-interface)).
- **Over SSH or the HDMI console:** run `sudo /ce/ce_conf.sh` (quit with Ctrl+C).

Settings are saved on the SD card and survive reboots.

### Main menu

| Screen | What you can set |
|---|---|
| **ACSI IDs config** / **SCSI IDs config** | For each ID 0–7 (use the entry matching your CosmosEx's interface): **off** (not responding), **sd** (the CosmosEx's own SD card slot, only one ID), **raw** (raw sector access, for Atari hard-disk drivers like HDDriver/ICD), **ce_dd** (translated drives, booted with the CE_DD driver). Default: ID 1 = ce_dd. |
| **Translated disks** | Drive letters for the first translated drive (default `C:`), the shared drive (`P:`) and the config drive (`O:`). Whether USB media are mounted **translated** (as GEMDOS drives, any PC file system) or **RAW** (Atari-partitioned media as raw disks). Whether ZIP files appear as **files** or as **directories**. |
| **Hard Disk Image** | Path of an `.IMG` hard-disk image to attach as a raw disk (needs an ID set to raw). Paths starting with `shared` or `usb` are completed automatically; `*` wildcards work. Easier: double-click an `.IMG` on a translated drive on the Atari to mount it with `CE_HDIMG.TTP`. |
| **Shared drive** | A folder on another computer, shown as a drive on the Atari: enable, protocol **NFS** or **Samba/CIFS** (Windows share), server **IP address** (names aren't accepted), shared folder path, username and password (Samba only). The **Test** button does nothing (it isn't implemented in the CosmosEx software). The share is mounted when the drive is first used, so a server that is switched on after the CosmosEx is picked up automatically; after a failed attempt the next try is 30 seconds later. If the server becomes unreachable, accesses fail after a few seconds (stock froze until the server came back). The share is unmounted after 5 minutes without use. Mount problems are logged in `/var/log/ce-shared-mount.log` and the system log. |
| **Floppy config** | Floppy emulation on/off, drive ID (0 or 1), write protection, seek sound. |
| **Network settings** | Hostname, DNS server. **Ethernet:** DHCP or static IP address, mask, gateway. **Wi-Fi**: enable, network name (SSID), password (PSK), DHCP or static. WPA2/WPA3 personal networks, 2.4 and 5 GHz (Pi 3 B+). The network name and password must not contain `"` (the CosmosEx software writes them unquoted into the Wi-Fi configuration). In the web interface the network name field lists the networks in range when you click into it (the CosmosEx scans for a few seconds; **Scan** scans again), with signal strength and band, and typing narrows the list; a network that hides its name is typed in. Changes apply within a few seconds, no reboot needed. The country for Wi-Fi channels is always GB (set by the CosmosEx software); this matters only for some 5 GHz channels outside Europe. |
| **IKBD** | USB keyboard, mouse and joysticks on the Atari: first joystick as JOY 0, mouse wheel as cursor up/down, keyboard joystick 0/1 (on/off; also with hotkeys Ctrl+Shift+Undo/F12). |
| **Other** | Set the time from the internet (on/off), NTP server, time zone (a place such as Europe/Stockholm, which follows daylight saving time by itself; or "Fixed UTC offset" with a number of hours), screencast frame skip (10–255), screen resolution written to `DESKTOP.INF` (low/mid). **Reset all settings** returns everything to the defaults. |
| **Update software** | Shows hardware version, interface type (ACSI/SCSI) and firmware versions, and starts an online update or an update from USB. See [Updates](#7-updates-and-chip-firmware). |

A changed **hostname** takes effect after a reboot, as on the stock image.

### Drives

- **USB drives:** plug a USB stick or disk into the Pi; it appears as a translated drive on the Atari within a few seconds. Supported file systems: FAT/FAT32, exFAT, NTFS and ext4 (exFAT is new; the stock image supports the other three).
- **Folders on the CosmosEx as drives:** in the web interface, Hard disk → Translated drives → **Create drive** makes a drive on the CosmosEx's own storage: pick a free letter (C to P; not the shared or config drive's) and it's there; the ST sees it after its next reset. It has no size of its own: it uses the storage's free space. Its row has **Open in Files**, to copy programs onto it, and **Remove**, which asks first and says how much is on it (removing deletes the files). The drive is the folder `/storage/translated_G` (for G:); making such a folder over the network (see [/storage over the network](#storage-over-the-network)) or over SSH does the same, after a restart or the next change on that page. USB drives skip the letters these drives have.
- **Hard disk images:** an image file the ST sees as a raw ACSI/SCSI hard disk (it needs a hard disk driver such as HDDRIVER or ICD, as with a real disk). Everything about them is on the web interface's **Hard disk** page: the images in `/storage/hdd_images` (copy them there over the network, see [/storage over the network](#storage-over-the-network)) and image files (`.img`, `.hd`, `.hdd`, `.ima`, `.raw`) in the top folder of USB drives. **Attach** one: it goes to a Raw ID without an image (the page offers to switch a free ID to Raw when there's none). Several images at once: one per Raw ID, each its own disk for the ST's driver (HDDRIVER, ICD…); pick them on the Raw IDs' cards in the bus above, each read-only or not. **Look inside** opens the image on the [Files](#files) page: its partitions as folders (PC or Atari AHDI/ICD partition table), the ones Linux reads (FAT/GEMDOS with logical sectors up to 4 KB, ext2/3/4 as MiNT uses) to browse, download, and change while the image isn't attached; not for an image the ST has attached read-write. **New blank image** makes one of zeros (like `mkfile 1024m`; 16 MB to 4 GB): attach it, then partition and format it on the ST with your hard disk driver. Each image can be **downloaded**; the ones in `/storage/hdd_images` can also be **renamed** and **deleted** (not while attached), and have a notes field (what's on it, which driver or TOS it needs…), kept next to the image as `<image>.json`. **Another file** takes any path under `/mnt/` or `/storage/`; not the shared drive (a dropped connection can corrupt the image). Changes are saved at once; the ST sees them after a reset.
- **Floppy images:** in the web interface, upload `.ST`, `.MSA` or zipped images, or search the library and download games. Where downloads go is set in Config → Floppy drive → "Downloaded images go to": `auto` (the first USB drive, else the shared drive, both in the folder `floppy_images`, else `/storage/img_download`), `shared` (the shared drive even when a USB drive is plugged in), or a folder (`share:/folder`, `usb:SERIAL:/folder`, `local:/folder` on `/storage`). When that place isn't there, downloads are kept in RAM until the next power-off; the Floppy page says so.
- **The CosmosEx's own disks:** the Floppy page has two buttons under the slots, **Config disk** (`ce_conf.st`: `CE_CONF` and the drivers, to set the CosmosEx up from the ST) and **Floppy test disk** (`fdd_test.st`, for the floppy test in `CE_FDD`). Either goes into slot 1 and into drive A: (the page asks first when slot 1 holds an image). The ST gets a fresh copy every time: what it writes to these disks isn't kept.
- **Zipped floppy images** are unpacked into a 16 MB RAM disk when inserted and kept there, so inserting the same zip again is instant; the least recently used ones make room for new ones, never one that is in a slot. Writes to a zipped disk go to its unpacked copy (lost at power-off, as on stock; saves to the library are planned).
- **Library images from a USB stick or the shared drive that is no longer there** stay in the list, greyed out ("Not attached"), and come back when the drive does.

### /storage over the network

`/storage` (the rest of the SD card) is a network folder for your computers, set up in the web interface under **Config → Storage sharing**:

- **NFS** (Linux, macOS): macOS Finder → Go → Connect to Server → `nfs://<name>.local/storage`; Linux: `sudo mount -t nfs <name>.local:/storage /mnt`. NFS has no passwords: access is by computer (address, network or host name). Files are owned by the user `pi` whoever connects (default), or by each computer's own user ids.
- **SMB** (Windows, macOS): Windows File Explorer → This PC → Map network drive → `\\<name>\storage`; macOS Finder → Go → Connect to Server → `smb://<name>.local/storage`. Without a password (guest, default) or as the user `pi` with a password you set there.
- For each: on or off, read-write or read-only, and **which computers may connect** (default: private networks 10.x, 172.16–31.x, 192.168.x; better: only your own, e.g. `192.168.1.0/24`). For both, a firewall rule enforces it (SMB's port 445; NFS's ports 111, 2049 and its helpers on fixed ports 20048, 32765–32768), so it takes addresses and networks only; for NFS, `/etc/exports` names the same computers.
- The settings are in `/etc/ce-storageshare.conf` (by hand: edit, then `sudo ce-storageshare apply`). For a hand-written `/etc/exports` set `NFS_MANUAL=yes` there; the format is in [exports(5)](https://man7.org/linux/man-pages/man5/exports.5.html) (see also [exportfs(8)](https://man7.org/linux/man-pages/man8/exportfs.8.html) and, for Linux clients, [nfs(5)](https://man7.org/linux/man-pages/man5/nfs.5.html)). The SMB server is the Linux kernel's ksmbd: [ksmbd.conf(5)](https://github.com/cifsd-team/ksmbd-tools/blob/master/ksmbd.conf.5.in) (most terms as in Samba's [smb.conf(5)](https://www.samba.org/samba/docs/current/man-html/smb.conf.5.html)); its configuration is made from the settings file. macOS: [connect to a server](https://support.apple.com/guide/mac-help/connect-mac-shared-computers-servers-mchlp1140/mac).

## 6. The web interface

Open `http://<ip-address>/` in a browser (the address is on the HDMI screen).

| Page | What it does |
|---|---|
| **Overview** | chips, interfaces, drives, network, versions; the Atari tools (`CE_CONF.TOS`, `CE_DD.PRG`) to download |
| **Floppy** | the three floppy slots (upload, select, eject) and the image library (search, download, insert) |
| **Hard disk** | the ACSI/SCSI IDs, hard disk images, translated drives (see [Drives](#drives)) |
| **Files** | a two-pane file manager for the CosmosEx's drives and the inside of hard disk images (below) |
| **Remote** | the Atari screen (screencast, screenshots), keyboard, mouse and joystick from your browser |
| **Config** | all CosmosEx settings, including the library sources and where downloads go; the classic configuration terminal (`/config.html`) is still there for anything else |

The old page addresses (`/floppy.html`, `/download.html`, `/remote.html`, `/screenshots.html`) open the new pages.

**Restart** (in the menu) restarts the CosmosEx after asking; the page waits and reloads when it's back (about a minute). With **Try to reset the host** ticked, the ST is reset first (as Ctrl+Alt+Del), and 0.2 s later the CosmosEx app stops and the CosmosEx restarts: a write the ST was in the middle of is cut off by the ST's reset, not by the CosmosEx going away. It needs the CosmosEx driver (`CE_DD.PRG`, loaded when the ST starts from the CosmosEx) running on the ST: it asks the CosmosEx once a second. A crashed ST, a game started from a floppy, or a program that took over the machine doesn't answer; the page then says the ST wasn't reset, and the CosmosEx restarts anyway. The ST starts again without the CosmosEx (it's going down): reset the ST once more when the CosmosEx is back. The driver from older images doesn't know the request: the ST has to start once with this image's driver first.

### Files

Two panes side by side, as in Midnight Commander; each shows a folder in one of the CosmosEx's places, picked at its top: a translated drive from a folder (`/storage/translated_X`), a USB drive, the shared drive, a hard disk image, or `/storage` as a whole. An image shows its **partitions as folders**; Enter opens one, `..` at its top goes back to the partitions.

- **Keys:** arrows, Page Up/Down, Home/End; **Enter** opens a folder (a file: the viewer); **Backspace** goes up; **Tab** switches pane; **Insert** or **Space** selects (also Shift+click, Ctrl/⌘+click, Ctrl/⌘+A); typing the start of a name jumps to it. Commands: **2** rename, **3** view, **4** upload, **5** copy and **6** move to the other pane, **7** new folder, **8** delete, **9** download (several files or a folder: one zip); **F2**–**F9** work too where the browser lets them (Shift+F6 renames, as in mc). The bar below the panes has the same buttons; on a phone one pane shows at a time (Left / Right).
- **Copy and move** go from the active pane into the folder the other pane shows: the selection, or the entry at the cursor; or drag rows onto the other pane (Shift: move). Between any two places, images included; names become 8.3 in a GEMDOS partition (two long names that shorten alike get `~1`, `~2`), files keep their dates. A name already there asks (Replace puts two folders together, replacing files with the same names). The copy runs on the CosmosEx: a progress bar with Cancel (the half-written file is removed); it goes on if you leave the page, and the page shows it again when you come back. One copy or move at a time.
- **View** (**3**, or Enter on a file): text in the Atari character set (umlauts, ß and the rest as on the ST), Degas (`.PI1`–`.PI3`, compressed `.PC1`–`.PC3`) and NEOchrome (`.NEO`) pictures, PNG/JPEG/GIF as they are, anything else as hex (Text / Hex switch; pictures: Picture / Text / Hex); ← and → go to the previous or next file. Big files: the first 512 KB.
- **Edit** (in the viewer, files up to 512 KB where the pane can be changed): in **Text** mode the file in the Atari character set: control bytes show as their symbols (␚ for the 0x1A many Atari texts end with) and are kept, a CR LF file is saved with CR LF again, and a character TOS has no code for (€, emoji) is refused with a message instead of being changed. In **Hex** mode pairs of hex digits, 16 a line; bytes can be changed, added or removed. **Save** (or Ctrl/⌘+S) writes the file back under its name; **Cancel edit**, Close or ←/→ ask before throwing changes away. Where the place can't be changed (an attached image, a read-only drive), Edit is off and says why.
- **Upload:** drag files or whole folders from your computer onto a pane, or **4** to pick them. A name that's already there asks: Replace, Skip, Replace all, Skip all.
- **Hard disk images** open like folders: **Enter** or a double click on an image in `/storage/hdd_images` (or in the top folder of a USB drive) goes inside, to its partitions; `..` or **Backspace** at the top leads back to the folder, with the cursor on the image. View (F3) still shows the image file itself. They change only while the ST has them on **no ID**: the ST keeps its own copy of an image's folders and would undo the changes. Attached read-only: you can browse and download. Attaching an image closes it on the Files page first. Names on GEMDOS (FAT) partitions become **8.3 in capitals** (`my long name.prg` → `MY_LONG_.PRG`), as TOS needs them; the page tells you which names changed. MiNT (ext2) partitions keep long names.
- **An attached image and the network shares:** while an image in `/storage` is on an ID, its file can't be changed, deleted or renamed, neither here nor over NFS or SMB (it can still be read, e.g. copied off; a copy taken while the ST writes may be inconsistent). Over the shares it shows as owned by `root` until it is detached. Its folder is marked so that only a file's owner can delete or rename it; your own files there work as before. Images directly in `/storage` (not in a folder) can still be deleted or renamed over the shares. **Attaching** is refused while a program has the image open for writing over SMB or NFS 4 (close it there first). Over NFS 3 that can't be seen: the attach goes through and that program's later writes fail.
- **Translated drives, USB drives and the shared drive** can be changed while the ST uses them (as over NFS/SMB); the ST sees a change when it reads the folder again. Their names stay long (the CosmosEx shortens them for the ST).
- **Big Atari partitions and byte-swapped images:** GEMDOS partitions with logical sectors over 4 KB (big AHDI/HDDRIVER partitions; Linux's FAT driver stops at 4 KB) and byte-swapped images (from some emulators) are read through a translator, `ce-gemdosfs`; the partition list says e.g. "gemdos 8 KB sectors". So are small GEMDOS partitions with under 4085 clusters (under about 4 MB with 512-byte sectors; TOS uses FAT16 there, Linux alone would take them for FAT12): "gemdos 512-byte sectors, small FAT16". Browse, view, download and copy from them as from any other. **Changing them is experimental** and off: switch it on in Config → **Experimental**, and keep a copy of the image. Partitions it refuses: clusters over 64 KB, and, for writing, a root folder that doesn't fill whole sectors. The image's real boot sector is never written.

The web interface asks for a **password**. Until you set your own (Config → **Web login**), it is `thisisnotsecure`; the HDMI screen shows it while it's still the default. In Config → Web login you can set a new password (other browsers are then logged out) or switch the login off. A login lasts 30 days in a browser; **Log out** is in the menu.

Forgot the password? Put an empty file **`insecure.txt`** on the SD card's **CosmosEx** volume (where the SSH keys go): the login is off while it's there (the HDMI screen says so). Remove it to use the login again. See [Security](#10-security).

## 7. Updates and chip firmware

The image contains the final CosmosEx release (`stretch` branch, 2020). There are no newer releases, so updating is rarely needed.

### Backup and restore

**Config → Backup & restore** makes one file, `cosmosex-backup-<name>-<date>.tar.gz`, with what you set up and what the ST saved, so a new or rewritten card gets everything back: write the image, start the CosmosEx, open Config → Backup & restore and restore the file. The CosmosEx restarts with your settings.

In the backup:
- **Settings:** every CosmosEx setting (drives, IDs, floppy library sources…), network and the Wi-Fi network, hostname, sharing, the SSH keys from the boot partition.
- **Passwords and keys only if you tick "Include passwords and keys":** the Wi-Fi password, the shared drive password, the SMB password, the web password and the CosmosEx's own SSH identity (so your computers don't warn about a changed host key). The file is then encrypted with a backup password you choose (at least 8 characters; AES-256, the key made from the password with PBKDF2): `….tar.gz.enc`. Without the backup password it can't be restored; restoring asks for it, and a wrong password or a damaged file changes nothing. Without passwords and keys (the default), a restore keeps the ones the CosmosEx has and says which ones to enter again (on a new card: the Wi-Fi password, so connect a cable or put a `wpa_supplicant.conf` on the boot partition first).
- **Save disks:** floppy disks the ST wrote to (see below), and the notes about your hard disk images.
- If you tick them: the files of the translated drives on the CosmosEx (`/storage/translated_X`), and the downloaded floppy images (they can be downloaded again).

**Not in the backup: hard disk images.** They're big; download them on the Hard disk page (or copy them from `/storage/hdd_images` over the network) and keep them with the backup. The page asks you to confirm that ("Yes, I understand") before it makes the backup.

A restore replaces the settings (the ones before it are kept in `/data/ce/settings.before-restore`) and puts the files back; files of the same name are replaced, others are left alone. A file that isn't a CosmosEx backup, or holds anything other than files and folders at the places above, is refused without changing anything. Over SSH: `sudo ce-backup create > backup.tar.gz`, `sudo ce-backup restore <file>`.

### Save disks

Floppy disks the ST writes to are kept on the card (`/storage/floppy_disks`), one folder per disk, named after the disk and a fingerprint (hash) of the original file. Inserting the same disk again — from the library, under another name, from another list, downloaded again — gives you the disk as the ST left it (a game's saves, for example). Zipped images are unpacked there (not into RAM, so saves survive switching off); plain `.st`/`.msa` images from the library are copied there on insert and the ST writes to the copy (the download stays as it came). Your own image files elsewhere (USB, shared drive, translated folders) are written in place, as before. To start a disk afresh, delete its folder in `floppy_disks` (over the network). Disks the ST never wrote to are a cache there (up to 128 MB, the oldest go first).

### System updates (the whole image)

In the web interface, **Config → Software & update** shows the installed system and updates it, without rewriting the card:

- **From the CosmosEx site:** **Check now** reads the list of published images and shows the newest one of this CosmosEx's kind, then **Install … and restart** or **Install … only** downloads and installs it (see below). The download is checked against the list's SHA-256. HTTPS needs the clock: right after switching on, wait for the time sync.
  - **List of published images:** the address of the list, a JSON file; today `https://redux.cosmosex.net/images/latest.json`. Change it and press **Save** to get updates from somewhere else (a copy of the site on your own server, say); **Use the default** goes back. The address is kept with the settings, so it is in backups too. `http://` and `https://` addresses, with letters, digits and `. - _ ~ % + /` only.
  - **The list's format:** `{"images": {"armv7": {"version": "2026.11.17.1", "file": "…img.xz", "size": 25210708, "sha256": "…", "date": "2026-11-17"}, "armv6": {…}}}`. `file` is a whole address, or a path from the folder the list is in (when that folder is called `images`, as on the CosmosEx site, from the folder above it).
- **From a file:** an image as published (`cosmosex-armv7-….img.xz`) or an unpacked `.img`, uploaded from your computer (**Install and restart** / **Install only**), or put in the top folder of a USB stick (listed there with the same two choices). It has to be for this CosmosEx's kind (armv7, armv6 or arm64).

How it works: the SD card has two system partitions. The new system is written to the one not in use, read back and compared, and its start files (kernel, device trees, overlays) go to the boot partition next to the current ones. Then the CosmosEx restarts **once** into the new system (the Pi firmware's *tryboot*). When it starts and the CosmosEx app and chips answer, it becomes the default; the page shows "Updated from … to …". When it doesn't start, switch the CosmosEx off and on: the previous system starts, unchanged, and the page says the update failed. If the new system starts but the chips don't answer, the page asks: **Keep** it, or **Go back**.

**… and restart** restarts into the new system right away. **… only** installs it and keeps the current system running: the new one is tried at the next start, whether you click **Restart now** or switch the CosmosEx off and on (then it starts the old system first and restarts into the new one by itself, about 20 seconds longer). Until then, **Don't start it** cancels it.

**Systems on this card** lists both system partitions and their versions. **Active** marks the one running now. **Next boot** chooses the system the next start uses (nothing restarts; **Restart now** does). Use it to go back to the system installed before (it stays on the card until the next update replaces it), or to return to a newer one. An update always replaces the system that isn't running, so it needs the running system as the next start.

Settings, network settings, your files in `/storage` and the floppy images are kept: they're on their own partitions. Don't switch off during the write (the page says so); if it happens anyway, nothing changed and you can try again.

Not updated this way: the Pi firmware files on the boot partition (`bootcode.bin`, `start*.elf`, `fixup*.dat`), and your own files there (`config.txt` is replaced by the new system's: make your changes again if you changed it). Over SSH: `sudo ce-sysupdate status | check | online | install <file>`.

### The CosmosEx release (`/ce`)

- **Online update** is switched off on this image: Update software shows "no online update: new SD image", and **OnlineUp** does nothing. Update the system instead (above): it brings the app and the web interface. *(The stock online update needs git and HTTPS downloads, which this image doesn't have, and it would only replace the release's files, never the system.)*
- **Update from USB:** put the release archive named `stretch.zip` in the root of a USB drive, then Update software → **USB**. A zip from GitHub's "Download ZIP" (everything in one folder) works too. It updates the release's files and the chip firmware; the image keeps its own app and update scripts. A broken zip, or one that isn't a CosmosEx release, changes nothing.
- **Chip firmware** (Hans, Franz, Xilinx) is flashed automatically when an update brings new firmware, and when you switch the interface between ACSI and SCSI.
- **Flash Hans and Franz** (Config → Software & update → Chip firmware): writes this system's firmware to the two STM32 chips again, e.g. when one lost its firmware or has a different one. After you confirm, the CosmosEx restarts and flashes them before its app starts (a minute or two; the Atari has no CosmosEx drives meanwhile), and the page shows the result. If the power goes off during the flash, it's tried again at the next start. Not while a system update is in progress. Over SSH: `sudo ce-flash request hans franz`, then restart; `sudo ce-flash status`; the log is `/data/ce-flash/flash.log`.
- **Recovery flash:** put an empty file `doflash.txt` on the `CosmosEx` volume and boot. See [The boot partition](#2-the-boot-partition-settings-from-your-pc).

Don't switch off the CosmosEx while an update or flash is running.

## 8. Troubleshooting

**Collect a diagnostics report:** log in (SSH or HDMI console) and run:

```sh
ce-report
```

It writes everything useful (system and CosmosEx logs, devices, network, chip versions, settings) to `/tmp/ce-report.txt` and to `ce-report.txt` on the `CosmosEx` volume. If the network doesn't work, switch off, put the SD card in your PC, and take the file from the `CosmosEx` volume. Settings include your shared-drive password in plain text; remove it before sending the report to anyone.

**Log files** (`sudo less <file>`):

| File | Contents |
|---|---|
| `/var/log/ce.log` | the CosmosEx software |
| `/var/log/ceapp-init.log` | startup, first-boot preparation, recovery flash |
| `/var/log/ce_update.log` | updates |
| `/var/log/messages` | Linux system log |

**Common problems:**

| Symptom | Check |
|---|---|
| HDMI screen says "UNDER-VOLTAGE detected" | Use a better power supply. Under-voltage causes random resets and SD card errors. |
| App "NOT running" on the HDMI screen | It's restarted automatically within 5 seconds. If it stays down, run `ce-report`. |
| No IP address | Check the cable. With a static IP, check the network settings. Wi-Fi: check the network name and password, that Wi-Fi is enabled, and `wpa_cli -i wlan0 status` on the console (`wpa_state=COMPLETED` means connected); `iw dev wlan0 scan \| grep SSID` lists the networks the CosmosEx sees. |
| Atari doesn't see the CosmosEx | Check the ACSI/SCSI ID settings; ID 1 = ce_dd by default. |
| Chips misbehave after an interrupted update | Recovery flash with `doflash.txt`. |
| Settings made the CosmosEx unreachable | Factory reset with `factoryreset.txt` (keeps `/storage`). |
| Everything is broken | Write the image to the card again. Note: this also removes `/storage` from the card's partition table; back up your files first. |

## 9. Advanced settings

**App start options:** the file `/ce/default_args` (one line, space-separated) adds options to the CosmosEx software at every start. Useful ones:

| Option | Effect |
|---|---|
| `ll3` | most detailed logging in `/var/log/ce.log` (`ll0`–`ll3`; default 1) |
| `ikbdlogs` | log keyboard/mouse traffic to `/var/log/ikbdlog.txt` |
| `noreset` | don't reset Hans and Franz when the app starts |

Example: `echo ll3 | sudo tee /ce/default_args`, then reboot.

**Boot configuration (`config.txt` on the `CosmosEx` volume):** these lines must stay as they are, because the CosmosEx hardware depends on them:

```
dtparam=i2c_arm=off
dtparam=spi=off
core_freq=250
dtoverlay=disable-bt
enable_uart=1
```

The Pi's serial port (GPIO 14/15) is wired to the CosmosEx chips. Never add a serial console (`console=serial0` or `console=ttyAMA0`) to `cmdline.txt`; it would send Linux messages into the CosmosEx hardware.

**How the card is organised:**

| Partition | Size | Mounted at | Contents |
|---|---|---|---|
| 1 `CosmosEx` (FAT) | 48 MB | `/boot`, read-only | firmware, kernel, the files from section 2 |
| 2 system (ext4) | 128 MB | `/`, **read-only** | Linux and the CosmosEx software as shipped |
| 3 system B | 128 MB | `/` when it's the one running | the other system: system updates go to whichever isn't running |
| 5 settings (ext4) | 128 MB | `/data` | CosmosEx settings (`/ce`), changed system settings (`/etc`), logs (`/var/log`), home directories, SSH identity |
| 6 `/storage` (ext4) | the rest | `/storage` | your files (`/storage/img_download`, more in a later version) |

The system partition is never written while running, so a power cut can't damage it. Settings and logs are on a journaled partition that is checked (and repaired if needed) at every boot. The CosmosEx always boots: if the settings partition is beyond repair, it is recreated with factory settings and `ce-recovery.txt` on the `CosmosEx` volume says so. Logs are kept below about 2 MB each (one older copy, `.1`).

For debugging, `sudo ce-rw` makes the system partition writable until `sudo ce-ro` or the next reboot. Changes made that way are part of the system, not of the settings, so a factory reset doesn't undo them, but writing a new image does.

### The web server

Two programs answer the web interface. **nginx** listens on port 80 and is what your browser talks to; it keeps connections open between requests, compresses pages and lists, and passes everything on to the **CosmosEx app**, whose own web server listens on `127.0.0.1:8081` (reachable from the CosmosEx only) and makes every answer: pages, API, login.

- Settings: `/etc/nginx/nginx.conf` (part of the system, replaced by an update). Start, stop, reload: `sudo /etc/init.d/S01nginx start|stop|restart|reload`.
- Nothing is logged to the card: no access log; errors go to `/run/nginx/error.log` (RAM, gone at a restart).
- Uploads and downloads pass straight through without being stored on the way, whatever their size.
- "502 Bad Gateway" from nginx means the app isn't answering (starting, restarting, or stopped): `ps | grep cosmosex`, `/var/log/ce.log`.
- Scripts on the CosmosEx itself can use `http://localhost/` or `http://127.0.0.1:8081/`; neither needs the web login.
- **Developer mode** makes the app answer on port 8081 on the network too (`http://<ip-address>:8081/`), past nginx: for when nginx doesn't work and you want to restart or update from a browser. Switch it on in Config → Experimental, or put an empty file `devmode.txt` on the boot partition (that works without the web interface); it's used from the next restart. The login applies on that port as well. Leave it off otherwise.

## 10. Security

- **Linux logins** are locked down: SSH only with keys you put on the `CosmosEx` volume, no root login, no default passwords. Administrator access is through `sudo` as user `ce`.
- **The web interface (port 80) asks for a password** (stock had none). Change the default (`thisisnotsecure`) in Config → Web login. It is plain HTTP: the password crosses your network unencrypted, so use it on networks you trust and don't forward port 80 from the internet. Wrong passwords are slowed down (1 s each, a minute's pause after 10). `insecure.txt` on the CosmosEx volume switches the login off. Requests from the CosmosEx itself (127.0.0.1) need no login.
- **Shared-drive passwords** are stored in plain text in the CosmosEx settings, as on stock.
- **`/storage` is shared over NFS and SMB without a password by default**, to private network addresses (see [/storage over the network](#storage-over-the-network)): anyone on your network can read and change the files there. In Config → Storage sharing, limit it to your own network, make it read-only, give SMB a password, or switch either off.
- From the Atari, the config tool can open a Linux shell with administrator rights. That requires physical access to the Atari.
