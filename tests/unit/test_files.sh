#!/bin/sh
# Unit tests for ce-files (package/ce-files), on the build host: a fake
# /storage and /mnt in a temp folder, a stub for ce-hdinspect.
#   test_files.sh <ce-files binary>
F=$1
T=$(mktemp -d)
export CE_FILES_STORAGE=$T/storage CE_FILES_MNT=$T/mnt CE_FILES_HDINSPECT=$T/hdinspect
pass=0; fail=0
check() {   # description, expected, got
	if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL  %s: got [%s], want [%s]\n' "$1" "$3" "$2"; fi
}
val() { sed -n "s/^$1=//p"; }

mkdir -p $T/storage/translated_G/GAMES $T/storage/hdd_images $T/mnt $T/outside $T/imgroot
echo secret > $T/outside/secret.txt
echo hello > $T/storage/translated_G/GAMES/hello.txt
ln -s $T/outside $T/storage/translated_G/link
ln -s $T/outside/secret.txt $T/storage/translated_G/filelink
: > $T/storage/hdd_images/disk.img
echo '{}' > $T/storage/hdd_images/disk.img.json
# the stub: an image partition is the folder imgroot, FAT, writable
cat > $T/hdinspect <<STUB
#!/bin/sh
[ "\$1" = mount ] || exit 1
echo root=$T/imgroot; echo writable=yes; echo fs=fat
STUB
chmod 755 $T/hdinspect

# places
out=$($F places)
check "places: storage"                 1 "$(echo "$out" | grep -c '^place=storage	')"
check "places: translated G"            1 "$(echo "$out" | grep -c '^place=tr:G	')"
check "places: the image, not its .json" "image=$T/storage/hdd_images/disk.img	0" "$(echo "$out" | grep '^image=')"

# listing
out=$($F ls tr:G /)
check "ls: writable"                    yes "$(echo "$out" | val writable)"
check "ls: long names kept"             no "$(echo "$out" | val names83)"
check "ls: folder"                      1 "$(echo "$out" | grep -c '^d	0	[0-9]*	GAMES$')"
check "ls: links shown as links"        2 "$(echo "$out" | grep -c '^l	')"
check "ls: into a folder"               1 "$($F ls tr:G /GAMES | grep -c 'hello.txt$')"

# never outside a place
$F ls tr:G /../.. > $T/o; check "ls .. refused"           1 "$?"
$F ls tr:G /link > $T/o; check "ls through a link refused" 2 "$?"
$F cat tr:G /filelink > $T/o; check "cat a link refused"   2 "$?"
$F cat tr:G /link/secret.txt > $T/o; check "cat through a link refused" 2 "$?"
$F ls tr:Z / > $T/o; check "unknown drive letter"          2 "$?"
$F ls usb:nothere / > $T/o; check "USB drive not mounted"   2 "$?"
$F ls 'usb:../storage' / > $T/o; check "usb:.. refused"     2 "$?"
$F ls "img:1:/etc/passwd" / > $T/o; check "an image outside the list refused" 2 "$?"
$F ls "img:1:$T/storage/hdd_images/disk.img.json" / > $T/o; check "a .json isn't an image" 2 "$?"
$F rm tr:G / .. > $T/o; check "rm .. refused"               1 "$?"
$F rm tr:G / 'a/b' > $T/o; check "rm a/b refused"           1 "$?"

# an upload in progress isn't listed
: > $T/storage/translated_G/.ce-upload-123.tmp; : > $T/storage/translated_G/CEUPLOAD.TMP; : > $T/storage/translated_G/.ce-upload-x.tmp
check "upload temp files not listed"    0 "$($F ls tr:G / | grep -c -e '\.ce-upload-123' -e CEUPLOAD)"
check "  ... other dot files are"       1 "$($F ls tr:G / | grep -c '\.ce-upload-x\.tmp')"
rm -f $T/storage/translated_G/.ce-upload-123.tmp $T/storage/translated_G/CEUPLOAD.TMP $T/storage/translated_G/.ce-upload-x.tmp

# cat
check "cat"                             hello "$($F cat tr:G /GAMES/hello.txt)"

# put
printf 'abc' | $F put tr:G /GAMES "Long Name.txt" 3 > $T/o
check "put: long name kept"             "Long Name.txt" "$(val name < $T/o)"
check "put: contents"                   abc "$(cat "$T/storage/translated_G/GAMES/Long Name.txt")"
printf 'abc' | $F put tr:G /GAMES "Long Name.txt" 3 > $T/o; rc=$?
check "put: same name -> exists"        3 "$rc"
check "put: exists= given"              "Long Name.txt" "$(val exists < $T/o)"
printf 'xy' | $F put tr:G /GAMES "Long Name.txt" 2 overwrite > /dev/null
check "put: overwrite"                  xy "$(cat "$T/storage/translated_G/GAMES/Long Name.txt")"
printf 'x' | $F put tr:G /GAMES short.txt 5 > $T/o; rc=$?
check "put: cut short refused"          1 "$rc"
check "put: nothing left"               0 "$(ls -a $T/storage/translated_G/GAMES | grep -c -i 'short\|upload')"
printf 'x' | $F put tr:G /GAMES GAMES 1 > /dev/null; # a file named like... (in GAMES: no clash)
printf 'x' | $F put tr:G / GAMES 1 > $T/o; check "put over a folder refused" 3 "$?"
printf 'x' | $F put tr:G /link x 1 > $T/o; check "put through a link refused" 2 "$?"
check "nothing written outside"         secret.txt "$(ls $T/outside)"

# image partition (stub): names 8.3
printf 'prg' | $F put "img:1:$T/storage/hdd_images/disk.img" / "my long name.prg" 3 > $T/o
check "image: 8.3 name"                 MY_LONG_.PRG "$(val name < $T/o)"
check "image: written"                  prg "$(cat $T/imgroot/MY_LONG_.PRG)"
check "image: ls says names83"          yes "$($F ls "img:1:$T/storage/hdd_images/disk.img" / | val names83)"

# mkdir, rename, rm
check "mkdir"                           "new folder" "$($F mkdir tr:G / "new folder" | val name)"
$F mkdir tr:G / "new folder" > $T/o; check "mkdir twice -> exists" 3 "$?"
check "rename"                          renamed "$($F rename tr:G / "new folder" renamed | val name)"
check "rename to an existing name"      3 "$($F rename tr:G / renamed GAMES > /dev/null; echo $?)"
mkdir -p $T/storage/translated_G/renamed/sub; echo 1 > $T/storage/translated_G/renamed/sub/f
check "rm a folder with things in it"   1 "$($F rm tr:G / renamed | val deleted)"
check "rm a link removes the link only" 1 "$($F rm tr:G / link | val deleted)"
check "  ... its target still there"    secret "$(cat $T/outside/secret.txt)"

# zip: checked with Python's zipfile
mkdir -p $T/storage/translated_G/GAMES/SUB; head -c 100000 /dev/urandom > $T/storage/translated_G/GAMES/SUB/rand.bin
$F zip tr:G / GAMES > $T/out.zip
python3 - "$T/out.zip" "$T/storage/translated_G" > $T/o <<'PY'
import sys, zipfile, os
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
names = sorted(z.namelist())
same = all(z.read(n) == open(os.path.join(sys.argv[2], n), 'rb').read() for n in names if not n.endswith('/'))
print('bad=%s' % bad); print('names=%s' % ','.join(names)); print('same=%s' % same)
PY
check "zip: no damaged entries"         None "$(val bad < $T/o)"
check "zip: the tree"                   "GAMES/,GAMES/GAMES,GAMES/Long Name.txt,GAMES/SUB/,GAMES/SUB/rand.bin,GAMES/hello.txt" "$(val names < $T/o)"
check "zip: same bytes"                 True "$(val same < $T/o)"
$F zip tr:G / nothere > $T/o; check "zip of a missing name" 2 "$?"




# copy and move (background jobs)
export CE_FILES_RUN=$T/run
waitjob() { for i in $(seq 1 100); do st=$($F job-status | val state); [ "$st" != running ] && break; sleep 0.1; done; echo "$st"; }
mkdir -p $T/storage/src/Folder/Inner $T/storage/dst
echo 1 > "$T/storage/src/Folder/a long name.txt"; echo 2 > "$T/storage/src/Folder/a long name2.txt"; echo 3 > $T/storage/src/Folder/Inner/x.prg
head -c 300000 /dev/urandom > $T/storage/src/big.bin; touch -d '2001-02-03 04:05' $T/storage/src/big.bin
check "copy: started"                   1 "$($F job-start copy storage /src storage /dst replace Folder big.bin | val started)"
check "copy: done"                      done "$(waitjob)"
check "copy: the same bytes"            0 "$(cmp $T/storage/src/big.bin $T/storage/dst/big.bin; echo $?)"
check "copy: the file's date kept"      "2001-02-03" "$(date -r $T/storage/dst/big.bin +%F)"
check "copy: the folder with all in it" 3 "$(find $T/storage/dst/Folder -type f | wc -l | tr -d ' ')"
check "copy: the source still there"    1 "$(ls $T/storage/src | grep -c big.bin)"
check "conflicts: both there"           2 "$($F conflicts storage /dst Folder big.bin new.txt | grep -c '^exists=')"
check "copy: skip keeps the target"     done "$(echo x > $T/storage/dst/big.bin; $F job-start copy storage /src storage /dst skip big.bin > /dev/null; waitjob)"
check "  ... unchanged"                 x "$(cat $T/storage/dst/big.bin)"
# into the image (stub, 8.3): long names that clash after shortening stay apart
rm -rf $T/imgroot/*
$F job-start copy storage /src "img:1:$T/storage/hdd_images/disk.img" / replace Folder > /dev/null
check "copy into an image: done"        done "$(waitjob)"
check "  ... 8.3 names, kept apart"     "A_LONG_N.TXT A_LONG~1.TXT" "$(ls $T/imgroot/FOLDER | grep TXT | sort -r | tr '\n' ' ' | sed 's/ $//')"
check "  ... renames reported"          1 "$($F job-status | grep -c '^renamed=.*a long name')"
check "  ... folders 8.3 too"           X.PRG "$(ls $T/imgroot/FOLDER/INNER)"
# move: a rename on the same file system
$F job-start move storage /dst storage /src replace big.bin > /dev/null; waitjob > /dev/null
check "move: gone from the source"      0 "$(ls $T/storage/dst | grep -c big.bin)"
check "move: at the target"             x "$(cat $T/storage/src/big.bin)"
# refusals
$F job-start copy storage /src storage /src/Folder replace Folder > $T/o; check "into itself refused" 1 "$?"
$F job-start copy storage /src storage /src replace big.bin > $T/o; check "the same folder refused" 1 "$?"
$F job-start copy storage /src storage /nothere replace big.bin > $T/o; check "a missing folder refused" 2 "$?"
$F job-start copy storage /src storage /dst replace ../x > $T/o; check "a bad name refused" 1 "$?"
# one at a time, and cancel
head -c 60000000 /dev/zero > $T/storage/src/huge.bin
$F job-start copy storage /src storage /dst replace huge.bin > /dev/null
$F job-start copy storage /src storage /dst replace big.bin > $T/o; check "a second job refused" 4 "$?"
$F job-cancel > /dev/null
check "cancel"                          cancelled "$(waitjob)"
check "  ... nothing half-written left" 0 "$(ls -a $T/storage/dst | grep -c -e huge -e upload)"

# options (Config, Experimental)
export CE_FILES_CONF=$T/files.conf
check "options: off by default"         no "$($F options | val gemdosWrite)"
check "option-set on"                   yes "$($F option-set gemdosWrite yes | val gemdosWrite)"
check "  ... kept"                      "GEMDOS_WRITE=yes" "$(cat $T/files.conf)"
check "option-set off"                  no "$($F option-set gemdosWrite no | val gemdosWrite)"
$F option-set other yes > $T/o; check "unknown option refused" 1 "$?"
$F option-set gemdosWrite maybe > $T/o; check "bad value refused" 1 "$?"
# an image partition read-only for a reason (stub): said in ls and in the refusal
cat > $T/hdinspect <<STUB
#!/bin/sh
[ "\$1" = mount ] || exit 0
echo root=$T/imgroot; echo writable=no; echo why_ro=experimental; echo fs=fat
STUB
check "read-only reason listed"         experimental "$($F ls "img:1:$T/storage/hdd_images/disk.img" / | val readonly)"
check "  ... and in the refusal"        1 "$($F mkdir "img:1:$T/storage/hdd_images/disk.img" / X | grep -c 'experimental')"

# an image attached to an ID (the app's settings): not replaced, deleted, renamed or moved
mkdir -p $T/settings $T/storage/hdd_images/sub
export CE_FILES_SETTINGS=$T/settings
echo data > $T/storage/hdd_images/att.img
echo data > $T/storage/hdd_images/sub/deep.img
echo data > $T/storage/hdd_images/free.img
printf '%s' "$T/storage/hdd_images/att.img" > $T/settings/HDDIMAGE_0
printf '%s RO' "$T/storage/hdd_images/sub/deep.img" > $T/settings/HDDIMAGE_3
printf 'x' | $F put storage /hdd_images att.img 1 overwrite > $T/o; check "attached image: replace refused" 4 "$?"
check "  ... says why"                  1 "$(grep -c 'attached to an ID' $T/o)"
$F rm storage /hdd_images att.img > $T/o; check "attached image: delete refused" 4 "$?"
$F rename storage /hdd_images att.img other.img > $T/o; check "attached image: rename refused" 4 "$?"
$F rm storage /hdd_images sub > $T/o; check "a folder with an attached (read-only) image: delete refused" 4 "$?"
check "  ... all still there"           "data data" "$(cat $T/storage/hdd_images/att.img $T/storage/hdd_images/sub/deep.img | tr '\n' ' ' | sed 's/ $//')"
$F job-start move storage /hdd_images tr:G / replace att.img > /dev/null; waitjob > /dev/null
check "attached image: move refused"    1 "$($F job-status | grep -c 'attached to an ID')"
check "  ... still there"               data "$(cat $T/storage/hdd_images/att.img)"
echo new > $T/storage/translated_G/att.img
$F job-start copy tr:G / storage /hdd_images replace att.img > /dev/null; waitjob > /dev/null
check "attached image: copy over it refused" data "$(cat $T/storage/hdd_images/att.img)"
$F rename storage /hdd_images free.img free2.img > /dev/null; check "another image: rename fine" 0 "$?"
$F rm storage /hdd_images free2.img > /dev/null; check "  ... and delete" 0 "$?"
rm -f $T/settings/HDDIMAGE_0
$F rm storage /hdd_images att.img > /dev/null; check "detached: delete fine" 0 "$?"

echo "$pass passed, $fail failed (ce-files)"
chmod 755 $T/storage/translated_G
rm -rf "$T"
[ "$fail" = 0 ]
