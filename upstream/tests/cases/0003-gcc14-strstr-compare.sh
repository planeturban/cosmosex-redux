#!/bin/sh
# The web API files that test strstr() with "> 0" compile with GCC 14, and mean the same.
#
# 15 places in webserver/api/resource/*.cpp have "strstr(...) > 0": an ordered
# comparison of a pointer with zero, which GCC 14 refuses. "!= NULL" says the
# same thing (found or not).
. "$(dirname "$0")/lib.sh"
cd "$CE" || exit 99
for f in configresource downloadresource floppyresource kbdresource mouseresource; do
	err=$(g++ -fsyntax-only -w $CEFLAGS webserver/api/resource/$f.cpp 2>&1 | grep -m 1 'error')
	[ -n "$err" ] && echo "      | $err"
	expect "webserver/api/resource/$f.cpp compiles" "" "$(echo "$err" | sed 's/.*error: //' | cut -c1-70)"
done
expect "no 'strstr(...) > 0' left in the tree" 0 "$(grep -rn 'strstr([^;]*) *> *0' --include='*.cpp' . | wc -l | tr -d ' ')"
finish
