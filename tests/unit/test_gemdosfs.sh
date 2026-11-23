#!/bin/sh
# Unit tests for ce-gemdosfs (package/ce-gemdosfs), on the build host, without
# FUSE (built with -DNO_FUSE; --cat dumps the translated partition). Writes are
# modelled as the FUSE layer does them: changes made in the translated dump
# (512-byte geometry) are copied back to the original except its first 512
# bytes; the original must then be a sound file system in its own geometry.
#   test_gemdosfs.sh <ce-gemdosfs binary> <host bin dir with mkfs.fat, fsck.fat, mtools>
G=$1; H=$2
T=$(mktemp -d)
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL  %s: got [%s], want [%s]\n' "$1" "$3" "$2"; fi; }
val() { sed -n "s/^$1=//p"; }
export MTOOLS_SKIP_CHECK=1 MTOOLS_NO_VFAT=1
mk() {   # file KB sector-size sectors-per-cluster root-entries
	rm -f "$1"; $H/mkfs.fat -C "$1" "$2" -S "$3" -s "$4" -F 16 -r "$5" -n TESTDISK > /dev/null 2>&1
}
size() { wc -c < "$1" | tr -d ' '; }
roundtrip() {   # image: put a file and a folder through the translated view, back into the original
	img=$1
	$G --bpb --cat "$img" 0 "$(size "$img")" > $T/v.img
	head -c 300000 /dev/urandom > $T/data.bin
	$H/mmd -i $T/v.img ::/GAMES
	$H/mcopy -i $T/v.img $T/data.bin ::/GAMES/DATA.BIN
	echo hello > $T/r.txt; $H/mcopy -i $T/v.img $T/r.txt ::/README.TXT
	cp "$img" $T/back.img
	dd if=$T/v.img of=$T/back.img bs=512 skip=1 seek=1 conv=notrunc 2>/dev/null
}

for bps in 4096 8192 16384; do
	mk $T/a.img 262144 $bps 2 512
	out=$($G --probe $T/a.img 0)
	check "$bps: probe ok"                      yes "$(echo "$out" | val ok)"
	check "$bps: sector size seen"              $bps "$(echo "$out" | val bps)"
	$G --bpb --cat $T/a.img 0 "$(size $T/a.img)" > $T/v.img
	check "$bps: translated: 512-byte sectors"  0 "$($H/fsck.fat -n $T/v.img > $T/f.txt 2>&1; echo $?)"
	check "$bps: translated: same size"         "$(size $T/a.img)" "$(size $T/v.img)"
	check "$bps: only the boot sector differs"  0 "$(cmp -s -i 512 $T/a.img $T/v.img; echo $?)"
	roundtrip $T/a.img
	check "$bps: written back: original sound"  0 "$($H/fsck.fat -n $T/back.img > $T/f.txt 2>&1; echo $?)"
	check "$bps: original's boot sector kept"   0 "$(cmp -s -n 512 $T/a.img $T/back.img; echo $?)"
	$G --bpb --cat $T/back.img 0 "$(size $T/back.img)" > $T/v2.img
	$H/mcopy -n -i $T/v2.img ::/GAMES/DATA.BIN $T/got.bin 2>/dev/null
	check "$bps: the file back, same bytes"     0 "$(cmp -s $T/data.bin $T/got.bin; echo $?)"
	check "$bps: fsck sees the files"           1 "$($H/fsck.fat -n -l $T/back.img 2>/dev/null | grep -c 'GAMES/DATA.BIN')"
done

# a partition inside an image (offset), and byte-swapped
mk $T/p.img 262144 8192 2 512
roundtrip $T/p.img
head -c 1048576 /dev/zero > $T/disk.img; cat $T/back.img >> $T/disk.img
check "offset: probe at 1 MB"               yes "$($G --probe $T/disk.img 1048576 | val ok)"
$G --bpb --cat $T/disk.img 1048576 "$(size $T/back.img)" > $T/v3.img
$H/mcopy -n -i $T/v3.img ::/README.TXT $T/got.txt 2>/dev/null
check "offset: a file read"                 hello "$(cat $T/got.txt)"
python3 -c 'import sys; d=bytearray(open(sys.argv[1],"rb").read()); d[0::2],d[1::2]=d[1::2],d[0::2]; open(sys.argv[2],"wb").write(d)' $T/disk.img $T/swapped.img
check "swapped: not readable as it is"      no "$($G --probe $T/swapped.img 1048576 | val ok)"
check "swapped: probe with --swap"          yes "$($G --swap --probe $T/swapped.img 1048576 | val ok)"
$G --swap --bpb --cat $T/swapped.img 1048576 "$(size $T/back.img)" > $T/v4.img
check "swapped: the same as unswapped"      0 "$(cmp -s $T/v3.img $T/v4.img; echo $?)"
$G --swap --cat $T/swapped.img 0 "$(size $T/disk.img)" > $T/unswapped.img
check "swapped: whole image swapped back"   0 "$(cmp -s $T/disk.img $T/unswapped.img; echo $?)"

# refused
# (mkfs.fat won't make these: the boot sectors patched)
patch() { python3 -c 'import sys,struct; f=open(sys.argv[1],"r+b"); f.seek(int(sys.argv[2])); f.write(struct.pack(sys.argv[3], int(sys.argv[4])))' "$@"; }
# under 4085 clusters: TOS's FAT16, which Linux (and mtools, fsck.fat) would
# take for FAT12 by the count. Shown as a FAT16 of 4085 clusters, the ones
# that aren't there marked bad. Made by mkfs.fat as a bigger FAT16, then cut
# down in the boot sector (and the FAT, for the short-FAT case).
few() {   # name, sector size, clusters, "short": the FAT cut to what those clusters need
	kb=262144; [ $2 = 512 ] && kb=32768
	mk $T/few.img $kb $2 2 512
	python3 - $T/few.img $3 "$4" <<'PY'
import sys, struct
p, n, short = sys.argv[1], int(sys.argv[2]), sys.argv[3] == 'short'
d = bytearray(open(p, 'rb').read())
bps, spc, res, nfat, rootent = struct.unpack_from('<HBHBH', d, 11)
spf, = struct.unpack_from('<H', d, 22)
root = (rootent * 32 + bps - 1) // bps
if short:                                   # the FATs only as long as n clusters need: the rest moves up
    nspf = ((n + 2) * 2 + bps - 1) // bps
    fats = b''.join(bytes(d[(res + i * spf) * bps:(res + i * spf + nspf) * bps]) for i in range(nfat))
    d = d[:res * bps] + fats + d[(res + nfat * spf) * bps:]
    spf = nspf
    struct.pack_into('<H', d, 22, spf)
tot = res + nfat * spf + root + n * spc
struct.pack_into('<H', d, 19, tot if tot < 65536 else 0)
struct.pack_into('<I', d, 32, 0 if tot < 65536 else tot)
open(p, 'wb').write(bytes(d[:tot * bps]) + b'\xa5' * 4096)     # what follows the partition: must stay as it is
PY
	out=$($G --probe $T/few.img 0)
	check "$1: probe ok"                        yes "$(echo "$out" | val ok)"
	check "$1: probe says few"                  yes "$(echo "$out" | val few)"
	len=$(( $(size $T/few.img) - 4096 ))
	$G --bpb --cat $T/few.img 0 $len > $T/v.img
	check "$1: shown: a sound file system"      0 "$($H/fsck.fat -n $T/v.img > $T/f.txt 2>&1; echo $?)"
	check "$1: ... a FAT16"                     1 "$($H/fsck.fat -n -v $T/v.img 2>/dev/null | grep -c '16 bit')"
	check "$1: ... of 4085 clusters"            1 "$($H/fsck.fat -n -v $T/v.img 2>/dev/null | grep -c ' 4085 data clusters')"
	free=$($H/mdir -i $T/v.img :: 2>/dev/null | grep 'bytes free' | tr -cd '0-9')
	check "$1: ... free space: the real clusters" $(( $3 * 2 * $2 )) "$free"
	head -c 300000 /dev/urandom > $T/data.bin
	$H/mmd -i $T/v.img ::/GAMES
	$H/mcopy -i $T/v.img $T/data.bin ::/GAMES/DATA.BIN
	echo hello > $T/r.txt; $H/mcopy -i $T/v.img $T/r.txt ::/README.TXT
	cp $T/few.img $T/back.img
	check "$1: written through"                 0 "$($G --bpb --rw --apply $T/v.img $T/back.img 0 $len; echo $?)"
	check "$1: the image's size kept"           "$(size $T/few.img)" "$(size $T/back.img)"
	check "$1: its boot sector kept"            0 "$(cmp -s -n 512 $T/few.img $T/back.img; echo $?)"
	check "$1: what follows the partition kept" 0 "$(tail -c 4096 $T/few.img | cmp -s - $T/tail.bin 2>/dev/null; tail -c 4096 $T/back.img > $T/tail.bin; tail -c 4096 $T/few.img | cmp -s - $T/tail.bin; echo $?)"
	$G --bpb --cat $T/back.img 0 $len > $T/v2.img
	check "$1: read again: sound"               0 "$($H/fsck.fat -n $T/v2.img > $T/f.txt 2>&1; echo $?)"
	$H/mcopy -n -i $T/v2.img ::/GAMES/DATA.BIN $T/got.bin 2>/dev/null
	check "$1: the file back, same bytes"       0 "$(cmp -s $T/data.bin $T/got.bin; echo $?)"
	# filled up: no more than the real clusters hold, nothing written past them
	head -c $(( $3 * 2 * $2 + 100000 )) /dev/urandom > $T/huge.bin
	$H/mcopy -i $T/v2.img $T/huge.bin ::/HUGE.BIN > /dev/null 2>&1
	check "$1: a file bigger than the room refused" 0 "$($H/mdir -i $T/v2.img ::/HUGE.BIN 2>/dev/null | grep -c "$(size $T/huge.bin)")"
	check "$1: ... and what was written goes through" 0 "$($G --bpb --rw --apply $T/v2.img $T/back.img 0 $len; echo $?)"
	check "$1: ... the image's size kept"       "$(size $T/few.img)" "$(size $T/back.img)"
	tail -c 4096 $T/back.img > $T/tail.bin
	check "$1: ... what follows kept"           0 "$(tail -c 4096 $T/few.img | cmp -s - $T/tail.bin; echo $?)"
}
few "few, 512-byte sectors"          512 4000 ""
few "few, 512, short FAT"            512 1500 short
few "few, 8 KB sectors"              8192 4000 ""
few "few, 8 KB, short FAT"           8192 700 short
mk $T/half.img 262144 16384 2 1024
patch $T/half.img 17 '<H' 768
check "root not filling its sectors: probe" no "$($G --probe $T/half.img 0 | val rootfill)"
check "  ... still readable"                0 "$($G --bpb --cat $T/half.img 0 $(size $T/half.img) > $T/v5.img; $H/fsck.fat -n $T/v5.img > /dev/null 2>&1; echo $?)"
check "  ... not writable"                  1 "$($G --bpb --rw --cat $T/half.img 0 $(size $T/half.img) > /dev/null 2>&1; echo $?)"
head -c 1048576 /dev/urandom > $T/junk.img
check "not a boot sector refused"           no "$($G --probe $T/junk.img 0 | val ok)"

echo "$pass passed, $fail failed (ce-gemdosfs)"
rm -rf "$T"
[ "$fail" = 0 ]
