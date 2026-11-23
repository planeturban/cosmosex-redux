#!/bin/sh
# A download from a server that has moved the file gets the file, not the "301 Moved" page.
#
# The downloader (downloader.cpp, run in its thread as in the app) against a
# local web server that answers /old/... with "301 Moved Permanently" and has
# the file at /new/... . Stock: the redirect isn't followed and the server's
# 162-byte HTML page is saved under the image's name and reported as a good
# download (this is what happens today to the images on exxosforum.co.uk,
# which moved to www.exxosforum.co.uk). Redirects that go in circles or
# to something that isn't http(s) must fail and leave no file.
. "$(dirname "$0")/lib.sh"
PORT=8097
SRV=$B/served; DL=$B/downloads
mkdir -p "$SRV" "$DL"
find "$DL" -type f -delete
# a "disk image": 737280 bytes that aren't an HTML page
head -c 737280 /dev/urandom > "$SRV/GAME.ST"
cp "$SRV/GAME.ST" "$SRV/PLAIN.ST"; cp "$SRV/GAME.ST" "$SRV/LOOP.ST"; cp "$SRV/GAME.ST" "$SRV/AWAY.ST"
sum=$(sha256sum < "$SRV/GAME.ST")

hbuild h_downloader "$HERE/harness/h_downloader.cpp" "$CE/downloader.cpp" "$CE/utils.cpp" "$CE/debug.cpp"
python3 "$HERE/harness/redirect-server.py" $PORT "$SRV" &
srv=$!
trap 'kill $srv 2>/dev/null' EXIT
for i in 1 2 3 4 5 6 7 8 9 10; do curl -s -o /dev/null "http://127.0.0.1:$PORT/new/GAME.ST" && break; sleep 0.3; done

get() { "$B/h_downloader" "http://127.0.0.1:$PORT/$1" "$DL" | sed -n 's/^status: //p'; }
size() { [ -f "$1" ] && wc -c < "$1" | tr -d ' ' || echo "no file"; }

expect "not moved: downloaded (as before)"          ok "$(get new/PLAIN.ST)"
expect "  ... the file itself"                      "$sum" "$(sha256sum < "$DL/PLAIN.ST")"
st=$(get old/GAME.ST)
echo "      | moved file: status $st, $(size "$DL/GAME.ST") bytes saved (the image has 737280, the 301 page 162)"
expect "moved: downloaded"                          ok "$st"
expect "  ... the file itself, not the 301 page"    "$sum" "$([ -f "$DL/GAME.ST" ] && sha256sum < "$DL/GAME.ST")"
expect "a redirect in circles: fails"               failed "$(get loop/LOOP.ST)"
expect "  ... nothing saved"                        "no file" "$(size "$DL/LOOP.ST")"
expect "a redirect to file://: fails"               failed "$(get away/AWAY.ST)"
expect "  ... nothing saved"                        "no file" "$(size "$DL/AWAY.ST")"
finish
