#!/bin/sh
# Every source file of ce_main_app compiles with GCC 14 (nothing else is in the way).
#
# All .cpp files of the app, with the makefile's defines for Raspbian Stretch,
# through GCC 14's compile step (no ARM CPU flags, no linking: the tree's
# prebuilt civetweb libraries are ARM ones).
. "$(dirname "$0")/lib.sh"
cd "$CE" || exit 99
n=0; broken=0
for f in $(find . -name '*.cpp' | sort); do
	n=$((n + 1))
	err=$(g++ -fsyntax-only -w $CEFLAGS "$f" 2>&1 | grep -m 1 'error')
	if [ -n "$err" ]; then broken=$((broken + 1)); echo "      | $err" | cut -c1-170; fi
done
expect "files that don't compile, of $n" 0 "$broken"
finish
