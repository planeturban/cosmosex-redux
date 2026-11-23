#!/usr/bin/env python3
"""gen-timezones.py: the web UI's time zone list (webui/js/timezones.js).

    tools/gen-timezones.py [ZONEINFO_DIR] > webui/js/timezones.js

Each zone's name (Europe/Stockholm) with its rule as a POSIX TZ string
(CET-1CEST,M3.5.0,M10.5.0/3), taken from the last line of the zone's compiled
file in ZONEINFO_DIR (default /usr/share/zoneinfo: macOS and any Linux with
tzdata have it). The CosmosEx has no time zone data of its own: the web page
sends the rule along with the name and the rule is what the device uses.
Run again when a country changes its rules. Needs Python 3 only.
"""
import os
import re
import sys

AREAS = ('Africa', 'America', 'Antarctica', 'Arctic', 'Asia', 'Atlantic', 'Australia', 'Europe', 'Indian', 'Pacific')
OK = re.compile(r'^[A-Za-z0-9<>+\-:,./]{1,48}$')        # what the app takes as a rule


def rule(path):
    with open(path, 'rb') as f:
        data = f.read()
    if data[:4] != b'TZif' or data[4:5] < b'2' or not data.endswith(b'\n'):
        return None
    return data[data.rindex(b'\n', 0, -1) + 1:-1].decode('ascii')


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else '/usr/share/zoneinfo'
    zones = []
    for area in AREAS:
        for d, _, files in os.walk(os.path.join(root, area)):
            for name in files:
                full = os.path.join(d, name)
                r = rule(full)
                if r is None or not OK.match(r):
                    sys.stderr.write('left out: %s (%r)\n' % (full, r))
                    continue
                zones.append((os.path.relpath(full, root), r))
    zones.sort()
    version = ''
    for v in ('+VERSION', 'tzdata.zi'):
        try:
            with open(os.path.join(root, v)) as f:
                version = f.readline().replace('# version', '').strip()
            break
        except OSError:
            pass
    print('// The time zones of Config > Clock & screen: name, rule (a POSIX TZ string).')
    print('// Made by tools/gen-timezones.py from tzdata %s: don\'t edit, run it again.' % (version or '(version unknown)'))
    print('export const ZONES = [')
    for name, r in zones:
        print("  ['%s', '%s']," % (name, r))
    print('];')


if __name__ == '__main__':
    main()
