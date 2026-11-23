#!/bin/sh
# Image names can't lead out of the image folder, folders aren't listed, the Wi-Fi password stays private.
#
# 1. floppy/imagestorage.cpp: the path the app opens for an image name from a
#    web request (/api/v1/download/insert ...). Stock: "../../secret.txt" is
#    joined to the folder as it is. The floppy loader then only takes .st,
#    .msa and .zip files, so those can be put in a slot from anywhere on the
#    device; for any other file the answer tells whether it exists.
# 2. The web server options of webserver.cpp, given to the civetweb the tree
#    bundles (lib/civetweb-master.zip, built here). Stock: a folder without an
#    index page is listed.
# 3. config/netsettings.cpp: wpa_supplicant.conf, which holds the Wi-Fi
#    password. Stock: written readable for every user, and the password is
#    written to the log at debug level.
. "$(dirname "$0")/lib.sh"

# --- 1
hbuild h_security "$HERE/harness/h_security.cpp" "$CE/floppy/imagestorage.cpp" "$CE/config/netsettings.cpp" "$CE/utils.cpp" "$CE/debug.cpp"
USB=$B/usb
mkdir -p "$USB/floppy_images"
echo "not a disk image" > "$B/secret.txt"
: > "$USB/floppy_images/GAME.ST"
where() { "$B/h_security" image-path "$USB" "$1" | sed -n 's/^path: //p'; }
inside() {     # is the path the app would open in the image folder?
	p=$(where "$1")
	[ -z "$p" ] && { echo refused; return; }
	case $(realpath -m "$p") in "$(realpath "$USB/floppy_images")"/*) echo inside ;; *) echo "OUTSIDE: $(realpath -m "$p")" ;; esac
}
expect "GAME.ST: in the image folder (as before)"  inside "$(inside GAME.ST)"
expect "  ... the very file"                       "$USB/floppy_images/GAME.ST" "$(where GAME.ST)"
expect "../../secret.txt: refused"                 refused "$(inside ../../secret.txt)"
expect "sub/../../../secret.txt: refused"          refused "$(inside sub/../../../secret.txt)"
expect "..: refused"                               refused "$(inside ..)"

# --- 2
CW=/work/build/civetweb
if [ ! -f $CW/civetweb.o ]; then
	mkdir -p $CW && unzip -q -o "$CE/lib/civetweb-master.zip" -d $CW
	gcc -w -std=gnu99 -fpermissive -DNO_SSL -I$CW/civetweb-master/include -c $CW/civetweb-master/src/civetweb.c -o $CW/civetweb.o 2> $CW/err \
		|| { echo "the bundled civetweb didn't build:"; grep -m 5 error $CW/err; exit 99; }
fi
WWW=$B/www; PORT=8096
mkdir -p "$WWW/css"
echo "<html>home</html>" > "$WWW/index.html"; echo "body{}" > "$WWW/css/style.css"; echo x > "$WWW/css/private-notes.txt"
{
	echo '#include <string.h>'; echo '#include <unistd.h>'; echo '#include "civetweb.h"'
	echo "#define DOCUMENT_ROOT \"$WWW\""; echo "#define PORT \"$PORT\""
	echo 'int main(void) {'
	# the options exactly as the tree's webserver.cpp has them
	awk '/const char \* options\[\] *=/ { on = 1 } on { print } on && /};/ { exit }' "$CE/webserver/webserver.cpp"
	echo '    struct mg_callbacks cb; memset(&cb, 0, sizeof(cb));'
	echo '    if(!mg_start(&cb, NULL, options)) return 1;'
	echo '    pause(); return 0; }'
} > "$B/listing.c"
gcc -w -I$CW/civetweb-master/include "$B/listing.c" $CW/civetweb.o -o "$B/listing" -lpthread -ldl 2> "$B/listing.err" \
	|| { echo "the web server test program didn't build:"; head -n 8 "$B/listing.err"; exit 99; }
"$B/listing" &
srv=$!
trap 'kill $srv 2>/dev/null' EXIT
for i in 1 2 3 4 5 6 7 8 9 10; do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.3; done
expect "a page: served (as before)"                200 "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/css/style.css")"
code=$(curl -s -o "$B/listing.out" -w '%{http_code}' "http://127.0.0.1:$PORT/css/")
echo "      | GET /css/ -> $code, $(grep -c 'private-notes' "$B/listing.out") mention(s) of the folder's files"
expect "a folder: not listed"                      0 "$(grep -c 'private-notes' "$B/listing.out")"
expect "  ... refused"                             403 "$code"
kill $srv 2>/dev/null

# --- 3
mkdir -p /etc/wpa_supplicant
F=/etc/wpa_supplicant/wpa_supplicant.conf
find /etc/wpa_supplicant -name wpa_supplicant.conf -delete
(umask 022; "$B/h_security" wifi HomeNet 's3cret-wifi-pass')
expect "wpa_supplicant.conf: written, with the password" 1 "$(grep -c 'psk="s3cret-wifi-pass"' $F)"
expect "  ... for root only"                       600 "$(stat -c %a $F)"
expect "the log at debug level: network settings dumped" 1 "$(grep -c 'wpa-ssid HomeNet' /tmp/h_security.log)"
expect "  ... without the password"                0 "$(grep -c 's3cret-wifi-pass' /tmp/h_security.log)"
chmod 644 $F
(umask 022; "$B/h_security" wifi HomeNet 's3cret-wifi-pass')
expect "a file that was readable for all: root only after a save" 600 "$(stat -c %a $F)"
finish
