#!/bin/sh
# make gets as far as linking when a library is where only the linker finds it.
#
# The makefile lists the -l libraries as prerequisites of the program, so GNU
# make itself goes looking for them, in its own few folders. When one is
# somewhere else (a cross compiler's sysroot, or as here libbcm2835.a in a
# folder given with -L), make stops with "No rule to make target '-lbcm2835'"
# before anything is compiled. A dry run (make -n) is enough to see it.
. "$(dirname "$0")/lib.sh"

# libbcm2835.a, built from the tree's own tarball, in a folder of its own
L=$B/sysroot/lib
if [ ! -f "$L/libbcm2835.a" ]; then
	mkdir -p "$L" "$B/bcm"
	tar xzf "$CE/lib/bcm2835-1.55.tar.gz" -C "$B/bcm" --strip-components=1
	gcc -w -c "$B/bcm/src/bcm2835.c" -o "$B/bcm/bcm2835.o" && ar rcs "$L/libbcm2835.a" "$B/bcm/bcm2835.o" || exit 99
fi

cd "$CE" || exit 99
out=$(make -n CPU_FLAGS= CFLAGS="-I./ -I/opt/bcm -DDISTRO_RASPBIAN -DDISTRO_STRETCH" LDFLAGS="-Llib -L$L" 2>&1)
echo "$out" | grep 'No rule\|Stop' | sed 's/^/      | /'
expect "make doesn't stop at a library"      0 "$(echo "$out" | grep -c "No rule to make target '-l")"
expect "the link command is reached"         1 "$(echo "$out" | grep -c -- '-o cosmosex_raspbian_stretch .*-lbcm2835')"
expect "  ... and still names every library" 1 "$(echo "$out" | grep -- '-o cosmosex_raspbian_stretch' | grep -c -- '-lrt -lanl -lpthread -lcurl -ldl -lutil -lbcm2835 -lcivetweb_raspbian_stretch')"
finish
