#!/bin/sh
# The three files that use time and thread functions without their headers compile with GCC 14.
#
# debug.cpp and acsicommand/dateacsicommand.cpp use localtime() / struct tm
# without <time.h>, floppy/mfmcachedimage.cpp uses pthread_mutex_lock()
# without <pthread.h>. Older compilers' headers pulled them in by the way;
# GCC 14 with a current glibc doesn't, and the build stops.
. "$(dirname "$0")/lib.sh"
cd "$CE" || exit 99
for f in debug.cpp acsicommand/dateacsicommand.cpp floppy/mfmcachedimage.cpp; do
	err=$(g++ -fsyntax-only -w $CEFLAGS "$f" 2>&1 | grep -m 1 'error')
	[ -n "$err" ] && echo "      | $err"
	expect "$f compiles" "" "$(echo "$err" | sed 's/.*error: //' | cut -c1-70)"
done
finish
