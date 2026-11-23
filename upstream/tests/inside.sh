#!/bin/sh
# The part of run.sh that runs in the container. /u is this folder's parent
# (patches, tests), /src the ce-atari tree to test against, both read only.
#
#   inside.sh [case name pattern]
#
# Makes /work/stock (the tree as it is), /work/pNNNN (stock with patch NNNN
# alone) and /work/all (stock with every patch), and runs each case of
# tests/cases on them:
#
#   NNNN-name.sh   must show the fault on stock, and pass with patch NNNN
#                  alone and with all patches
#   all-name.sh    must show the fault on stock and pass with all patches
#
# A case exits 0 (right), 1 (fault) or 99 (the test couldn't run).
only=${1:-}
W=/work
mkdir -p $W/log /opt/bcm
cd $W || exit 2

if [ ! -d $W/stock ]; then
	mkdir $W/stock
	cp -r /src/ce_main_app $W/stock/ || { echo "no ce_main_app in the tree given"; exit 2; }
	# the bcm2835 header the makefile expects installed (bundled in the tree)
	tar xzf $W/stock/ce_main_app/lib/bcm2835-1.55.tar.gz -C /tmp && cp /tmp/bcm2835-1.55/src/bcm2835.h /opt/bcm/
	cp -r $W/stock $W/all
	for p in /u/patches/*.patch; do
		n=$(basename "$p" | cut -c1-4)
		cp -r $W/stock $W/p$n
		(cd $W/p$n && patch -s -p1 < "$p") || { echo "patch $n doesn't apply to the tree alone"; exit 2; }
		(cd $W/all && patch -s -p1 < "$p") || { echo "patch $n doesn't apply after the ones before it"; exit 2; }
	done
fi

pass=0; fail=0
# one <case> <tree> <wanted: fault or right> -> prints a word, logs the output
one() {
	log=$W/log/$(basename "$1" .sh).$(basename "$2").txt
	sh "$1" "$2" > "$log" 2>&1
	rc=$?
	case "$rc:$3" in
		0:right|1:fault) pass=$((pass + 1)); return 0 ;;
	esac
	fail=$((fail + 1))
	case $rc in
		0)  echo "      UNEXPECTED on $(basename "$2"): passes, the fault was expected" ;;
		1)  echo "      UNEXPECTED on $(basename "$2"): shows the fault" ;;
		*)  echo "      TEST ERROR on $(basename "$2") (exit $rc)" ;;
	esac
	sed 's/^/        /' "$log" | tail -n 25
	return 1
}

for c in /u/tests/cases/[0-9a]*.sh; do
	name=$(basename "$c" .sh)
	case $name in *"$only"*) ;; *) continue ;; esac
	n=${name%%-*}
	title=$(sed -n '2s/^# *//p' "$c")
	ok=1
	one "$c" $W/stock fault || ok=0
	if [ "$n" != all ]; then one "$c" $W/p$n right || ok=0; fi
	one "$c" $W/all right || ok=0
	if [ $ok = 1 ]; then
		if [ "$n" = all ]; then printf 'ok    %-4s %s\n' "" "$title"
		else printf 'ok    %-4s %s\n' "$n" "$title"; fi
		grep -h '^    ok\|^    (' $W/log/$name.all.txt
	else
		printf 'FAIL  %-4s %s\n' "$n" "$title"
	fi
done
echo
echo "$pass runs as expected, $fail not (each case: the fault shows on the stock tree and is gone with the patch)"
[ $fail = 0 ]
