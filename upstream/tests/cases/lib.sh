# Sourced by every case. $1 is the tree to test (a ce-atari checkout, stock
# or patched). A case exits 0 when the tree behaves right, 1 when it shows
# the fault, 99 when the test itself couldn't run.
T=$1
CE=$T/ce_main_app
HERE=$(cd "$(dirname "$0")/.." && pwd)
B=/work/build/$(basename "$T")/$(basename "$0" .sh)
mkdir -p "$B"

# as the makefile compiles for Raspbian Stretch, without the ARM CPU flags
CEFLAGS="-I$CE -I/opt/bcm -DDISTRO_RASPBIAN -DDISTRO_STRETCH -D_FILE_OFFSET_BITS=64 -D_LARGEFILE64_SOURCE"

# hbuild <program> <harness.cpp> <files of the tree ...>
# A harness is the tree's own source file(s) under test, linked with stubs for
# the rest of the app. -include/-fpermissive get the stock files through
# GCC 14 (what the two build fixes are for); functions that aren't called are
# dropped, so their missing callees don't matter.
hbuild() {
	out=$1; shift
	g++ -w -g $CEFLAGS -include time.h -include pthread.h -fpermissive \
		-ffunction-sections -fdata-sections -I"$HERE/harness" "$@" \
		-o "$B/$out" -Wl,--gc-sections -lcurl -lpthread 2> "$B/$out.err" && return 0
	echo "the harness didn't build:"; grep -m 12 'error\|undefined' "$B/$out.err"
	exit 99
}

bad=0
# expect <what> <wanted> <got>
expect() {
	if [ "$2" = "$3" ]; then echo "    ok    $1"
	else echo "    FAULT $1: got [$3], want [$2]"; bad=1; fi
}
finish() { exit $bad; }
