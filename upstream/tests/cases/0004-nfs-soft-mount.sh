#!/bin/sh
# An NFS share is mounted soft, so a server that's gone gives an error instead of a freeze.
#
# Mounter::mountShared() (mounter.cpp) for an NFS share, with mount(2) itself
# replaced: what would the kernel have been asked for? Stock: "nolock,addr=..."
# only, which the kernel takes as a hard mount: every access waits for the
# server for ever, the app with it, and the ST hangs. With soft,timeo=20,
# retrans=2 an access fails after about 6 s.
# (The test checks the options, not the 6 s, which follows from them.)
. "$(dirname "$0")/lib.sh"
hbuild h_mounter "$HERE/harness/h_mounter.cpp" "$CE/mounter.cpp" "$CE/utils.cpp" "$CE/debug.cpp"
out=$("$B/h_mounter" nfs-options 192.168.123.5 /export/atari)
echo "$out" | sed 's/^/      | /'
opts=$(echo "$out" | sed -n 's/^mount: .* options=//p')
has() { case ",$opts," in *",$1,"*) echo yes ;; *) echo no ;; esac; }
expect "an NFS mount of the right share"   1 "$(echo "$out" | grep -c '^mount: type=nfs source=192.168.123.5:/export/atari ')"
expect "soft"                              yes "$(has soft)"
expect "a time limit (timeo, retrans)"     yes "$(has timeo=20)$(has retrans=2 | sed 's/yes//')"
expect "not hard"                          no "$(has hard)"
expect "nolock and the address, as before" yes "$(has nolock)$(has addr=192.168.123.5 | sed 's/yes//')"
finish
