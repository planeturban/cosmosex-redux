#!/bin/sh
# Build the ST side programs the image changes (now: CE_DD.PRG, the
# translated disk driver the ST loads from the CosmosEx at boot) with the
# m68k-atari-mint cross tools in Docker, and put them in package/ce-atari/st/.
# The ce-atari package installs them over the release's in the /ce seed.
#
#   tools/m68k/build-st.sh <ce-atari source with the package's patches applied>
#
# e.g. a git worktree of atarijookie/ce-atari at CE_ATARI_VERSION with
# package/ce-atari/*.patch applied (git am). The unchanged source builds to the
# release's CE_DD.PRG byte for byte except the build date (__DATE__).
set -e
SRC=${1:?usage: $0 <ce-atari source with the patches applied>}
HERE=$(cd "$(dirname "$0")" && pwd)
TOP=$(cd "$HERE/../.." && pwd)
W=$TOP/output-images/m68k                      # (Docker sees the project, not /tmp)

docker image inspect cosmosex-m68k >/dev/null 2>&1 || docker build -t cosmosex-m68k "$HERE"

rm -rf "$W/ce_dd_prg"
mkdir -p "$W"
cp -R "$SRC/ce_dd_prg" "$W/"
docker run --rm -v "$W:/w" cosmosex-m68k sh -c 'cd /w/ce_dd_prg && make'
mkdir -p "$TOP/package/ce-atari/st"
cp "$W/ce_dd_prg/ce_dd.prg" "$TOP/package/ce-atari/st/ce_dd.prg"
ls -l "$TOP/package/ce-atari/st/"
