# Fixes for ce-atari, with tests

Eight patches for `ce_main_app`, made against ce-atari commit `78a3d85` (the source of the last "stretch" release), and a test case for each. None of them needs anything else from the Buildroot image they come from: they fix the app as it is.

Each patch applies to `78a3d85` on its own (`git am patches/000N-*.patch`), and they apply together in order.

## The patches

| # | Patch | What was wrong |
|---|---|---|
| 1 | don't list -l libraries as make prerequisites | `make` stops with "No rule to make target '-lbcm2835'" when a library is where only the linker finds it (cross compiling). |
| 2 | add missing time.h and pthread.h includes | Three files don't compile with GCC 14. |
| 3 | compare strstr() results with NULL, not > 0 | Five files don't compile with GCC 14 (15 places). |
| 4 | mount NFS shares soft | With the NFS server gone, every access waits for ever and the ST hangs. Now it gets an error after about 6 s. |
| 5 | unmount a USB drive when it's unplugged | A pulled-out stick stays mounted until a reboot, so the next one becomes `sdb`, `sdc` ... |
| 6 | downloader: follow HTTP redirects | A moved file is saved as the server's 162-byte "301 Moved" page and reported as a good download. The images on exxosforum.co.uk do this today. |
| 7 | security fixes from a review | An image name like `../../other/DISK.ST` from a web request leads out of the image folder (to any `.st`, `.msa` or `.zip` on the device, and it tells whether any file exists); folders of the web root are listed; `wpa_supplicant.conf` is readable for all and the Wi-Fi password is logged at debug level. |
| 8 | loop devices aren't USB drives | A loop device, RAM disk or LVM volume with a file system shows up as a dead translated drive. |

Patches 2 and 3 together make the whole app compile with GCC 14.

## Running the tests

Docker is all that's needed.

```sh
tests/run.sh                     # fetches ce-atari 78a3d85 from GitHub once, tests against it
tests/run.sh ~/src/ce-atari      # or against a checkout (unpatched) you have
tests/run.sh "" 0006             # one case
```

It takes about a minute. For every case the runner checks three trees:

- the stock tree must **show the fault**,
- the stock tree with that one patch must pass,
- the stock tree with all eight patches must pass.

So a case that passes says both that the fault is real in the stock code and that the patch removes it. The last line counts the runs; the exit status is 0 when all went as expected.

The container is started privileged because one test really mounts and unmounts a file system. `NOPRIV=1 tests/run.sh` runs without, and skips that one part.

## What each case does

Most cases build a small program from **the tree's own source file** and stubs for the rest of the app (`tests/harness/`), so the code that runs is the code in the tree, not a copy.

| Case | Code under test | How |
|---|---|---|
| 0001 make | `makefile` | `make -n` with `libbcm2835.a` (built from the tree's tarball) in a folder given with `-L`. |
| 0002, 0003 GCC 14 | the 8 files the patches touch | GCC 14's compile step, with the makefile's defines. |
| all: whole app | all 99 `.cpp` files | The same for every file: nothing else stops GCC 14. Compile only; no link, the tree's civetweb libraries are ARM ones. |
| 0004 NFS | `mounter.cpp`, `Mounter::mountShared()` | Real function, `mount(2)` replaced: checks the options the kernel would get. |
| 0005 USB unplug | `devfinder.cpp`; `mounter.cpp`, `Mounter::tryUnmount()` | Device links made and removed in `/dev/disk`, as udev does, and the finder run: what does it ask the mounter for? Then a real tmpfs mount with a file open on it, and a real unmount. |
| 0006 redirects | `downloader.cpp`, run in its thread | A local web server that answers with 301. The saved file is compared with the original. Also: a redirect in circles and one to `file://` must fail and save nothing. |
| 0007 security | `floppy/imagestorage.cpp`; the options in `webserver.cpp`; `config/netsettings.cpp` | The path the app would open for hostile image names. The civetweb bundled in the tree (`lib/civetweb-master.zip`), built and started with the options exactly as `webserver.cpp` has them. The mode of the written `wpa_supplicant.conf` and the content of the debug log. |
| 0008 loop devices | `devfinder.cpp` | Links for `loop3`, `zram0`, `dm-0`, `ram1`, and those of a USB stick next to them (which must still be found). |

Each case's header comment says the same in more detail, and what the stock code does.

## What the tests don't show

- **0004** checks that the mount is made with `soft,timeo=20,retrans=2`, not how long an access then takes. The "about 6 s" is what those options add up to (a 2 s timeout, tried three times); this test doesn't measure it.
- **0005, 0008** drive the device finder with links in `/dev/disk`, not with real USB hardware.
- The harnesses are compiled with `-include time.h -include pthread.h -fpermissive`, so that the stock files get through GCC 14 at all (which is what patches 2 and 3 are for). With patches 2 and 3 applied the flags change nothing.
- Everything runs on the host's CPU in a Debian 13 container, not on a Raspberry Pi and not on Raspbian Stretch. Patch 6 uses the older `CURLOPT_REDIR_PROTOCOLS` on a libcurl before 7.85 (Stretch has 7.52); that branch is not compiled here.
- The cases run in one container one after the other and leave files in `/dev/disk` and `/etc/wpa_supplicant` of that container. It's thrown away afterwards.
