#!/bin/sh
# Unit tests for ce_main_app code that doesn't need the CosmosEx hardware.
# Runs in the build container (./build.sh test): compiles the patched app
# sources from a build tree (any variant) for the build host, with the tests here.
set -e
APP=$(ls -d /work/output/build/ce-atari-*/ce_main_app /work/output-armv7/build/ce-atari-*/ce_main_app /work/output-armv6/build/ce-atari-*/ce_main_app 2>/dev/null | head -1)
[ -n "$APP" ] || { echo "No patched ce-atari source: build an image first (./build.sh), or run ./build.sh armv7 ce-atari-patch"; exit 1; }
OUT=/tmp/ce-unit
mkdir -p $OUT
cd "$(dirname "$0")"

# zip fixtures for the unpack cache tests
python3 - <<'PY'
import zipfile
d = '/tmp/ce-unit/'
with zipfile.ZipFile(d + 'two.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('GAME.ST', bytes(737280))
    z.writestr('readme.txt', b'0123456789')
zipfile.ZipFile(d + 'empty.zip', 'w').close()
open(d + 'notzip.bin', 'wb').write(b'not a zip file at all, just text' * 4)
b = open(d + 'two.zip', 'rb').read()
open(d + 'cut.zip', 'wb').write(b[:len(b) - 30])
PY

g++ -std=gnu++11 -Wall -Wextra -O1 -g -I"$APP" -o $OUT/test_imagelib \
	test_imagelib.cpp "$APP/floppy/imagelibsources.cpp" "$APP/usbserial.cpp" "$APP/floppy/ziputil.cpp"
$OUT/test_imagelib

# ce-files (the Files page's tool), against Buildroot's host zlib
H=$(ls -d /work/output-armv7/host /work/output/host 2>/dev/null | head -1)
gcc -O2 -Wall -Wextra -Werror -I"$H/include" -o $OUT/ce-files /src/package/ce-files/src/ce-files.c "$H/lib/libz.a"
sh /src/tests/unit/test_files.sh $OUT/ce-files

# ce-gemdosfs (big GEMDOS partitions, byte-swapped images), without FUSE
mkdir -p $OUT/hostbin
for b in sbin/mkfs.fat sbin/fsck.fat bin/mcopy bin/mmd bin/mdir; do ln -sf "$H/$b" $OUT/hostbin/; done
gcc -O2 -Wall -Wextra -Werror -DNO_FUSE -o $OUT/ce-gemdosfs /src/package/ce-gemdosfs/src/ce-gemdosfs.c
sh /src/tests/unit/test_gemdosfs.sh $OUT/ce-gemdosfs $OUT/hostbin
