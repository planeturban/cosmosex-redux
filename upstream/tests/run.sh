#!/bin/sh
# Runs the test cases for the patches in ../patches, in a container (Debian 13,
# GCC 14). Needs Docker and nothing else.
#
#   tests/run.sh [ce-atari checkout] [case name pattern]
#
# Without a checkout, the source the patches are made against is fetched from
# GitHub once (ce-atari at 78a3d85, the commit of the last "stretch" release)
# and kept in ../.src. With one, that tree is tested: its ce_main_app must be
# the unpatched code, the patches are applied to copies inside the container.
#
# For every case: the stock tree must show the fault, the tree with that one
# patch must pass, and so must the tree with all patches. See README.md.
#
# The container runs privileged, for the one test that really mounts and
# unmounts (a busy tmpfs); NOPRIV=1 runs without, and skips that part.
COMMIT=78a3d85de852ec20776061b130058f67f5749ca8
cd "$(dirname "$0")/.." || exit 2
U=$PWD
SRC=${1:-}
if [ -z "$SRC" ]; then
	SRC=$U/.src
	if [ ! -d "$SRC/ce_main_app" ]; then
		echo "fetching ce-atari $COMMIT ..."
		mkdir -p "$SRC"
		curl -fsSL "https://github.com/atarijookie/ce-atari/archive/$COMMIT.tar.gz" \
			| tar xz -C "$SRC" --strip-components=1 "ce-atari-$COMMIT/ce_main_app" || exit 2
	fi
fi
SRC=$(cd "$SRC" && pwd) || exit 2
[ -d "$SRC/ce_main_app" ] || { echo "$SRC: no ce_main_app there"; exit 2; }

docker build -q -t ce-upstream-test "$U/tests" > /dev/null || exit 2
priv=--privileged
[ -n "$NOPRIV" ] && priv=
docker run --rm $priv -v "$U:/u:ro" -v "$SRC:/src:ro" ce-upstream-test sh /u/tests/inside.sh "${2:-}"
