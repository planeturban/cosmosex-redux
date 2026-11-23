// Unit tests for the hardware-independent parts of the floppy library work
// (ce-atari patch 0011): IMAGELIB_SOURCES parsing, locations, USB serials.
// Built for the build host by tests/unit/run.sh (./build.sh test).

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>
#include <sys/stat.h>
#include <unistd.h>

#include "floppy/imagelibsources.h"
#include "floppy/ziputil.h"
#include "usbserial.h"

static int failures = 0, checks = 0;

#define CHECK(cond) do { checks++; if(!(cond)) { failures++; printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); } } while(0)
#define CHECK_EQ(a, b) do { checks++; std::string _a = (a), _b = (b); if(_a != _b) { failures++; printf("FAIL %s:%d: %s == \"%s\", expected \"%s\"\n", __FILE__, __LINE__, #a, _a.c_str(), _b.c_str()); } } while(0)

static void testParseBasic(void)
{
    std::vector<ImageLibSource> s;
    std::vector<std::string> w;

    int n = ImageLibSources::parse("usb:4C530001230615117324:/atari/floppies, share:/atari/floppies, http://nas.lan/atari/imagelist.csv, http://joo.kie.sk/cosmosex/update/imagelist.csv", s, &w);
    CHECK(n == 4);
    CHECK(w.empty());
    CHECK(s[0].type == IMAGELIB_TYPE_USB);
    CHECK_EQ(s[0].serial, "4C530001230615117324");
    CHECK_EQ(s[0].path, "/atari/floppies");
    CHECK_EQ(s[0].id, "usb-4C530001230615117324");
    CHECK(s[1].type == IMAGELIB_TYPE_SHARE);
    CHECK_EQ(s[1].path, "/atari/floppies");
    CHECK(s[1].id.compare(0, 6, "share-") == 0 && s[1].id.length() == 12);
    CHECK(s[2].type == IMAGELIB_TYPE_WEB);
    CHECK_EQ(s[2].url, "http://nas.lan/atari/imagelist.csv");
    CHECK(s[2].id.compare(0, 8, "nas.lan-") == 0);
    CHECK_EQ(s[2].label, "WEB nas.lan");
    CHECK_EQ(s[3].label, "WEB joo.kie.sk");
    for(int i = 0; i < 4; i++) CHECK(s[i].enabled);
}

static void testWhitespaceAndEmpty(void)
{
    std::vector<ImageLibSource> s;
    int n = ImageLibSources::parse("  ,http://a.example/l.csv ,, \t share:/x/ ,", s);
    CHECK(n == 2);
    CHECK_EQ(s[0].url, "http://a.example/l.csv");
    CHECK_EQ(s[1].path, "/x");                          // trailing slash dropped

    n = ImageLibSources::parse("", s);
    CHECK(n == 0);
    n = ImageLibSources::parse(" , , ", s);
    CHECK(n == 0);
}

static void testCommaDecoding(void)
{
    std::vector<ImageLibSource> s;
    ImageLibSources::parse("share:/games%2C old, usb:SER1:/a%2cb, http://h.example/list%2C1.csv", s);
    CHECK(s.size() == 3);
    CHECK_EQ(s[0].path, "/games, old");                 // decoded in paths
    CHECK_EQ(s[1].path, "/a,b");                        // either case
    CHECK_EQ(s[2].url, "http://h.example/list%2C1.csv"); // URLs unchanged

    // other escapes are not decoded
    ImageLibSources::parse("share:/a%20b", s);
    CHECK_EQ(s[0].path, "/a%20b");

    // join() writes them back as %2C, parse(join(x)) == x
    std::string joined = ImageLibSources::join(s);
    std::vector<ImageLibSource> s2;
    ImageLibSources::parse("share:/games%2C old, !usb:SER1:/a%2Cb", s2);
    joined = ImageLibSources::join(s2);
    CHECK_EQ(joined, "share:/games%2C old, !usb:SER1:/a%2Cb");
    std::vector<ImageLibSource> s3;
    ImageLibSources::parse(joined, s3);
    CHECK(s3.size() == 2);
    CHECK_EQ(s3[0].path, "/games, old");
    CHECK(!s3[1].enabled);
}

static void testUnknownAndInvalid(void)
{
    std::vector<ImageLibSource> s;
    std::vector<std::string> w;
    int n = ImageLibSources::parse("ftp://x/y, share:/ok, usb::/nopath, usb:SER, file:///etc/passwd, share:/a/../b, gopher:x", s, &w);
    CHECK(n == 1);
    CHECK_EQ(s[0].path, "/ok");
    CHECK(w.size() == 6);
}

static void testDisabled(void)
{
    std::vector<ImageLibSource> s;
    int n = ImageLibSources::parse("!usb:SER:/a, http://x.example/l.csv, ! share:/b", s);
    CHECK(n == 3);
    CHECK(!s[0].enabled);
    CHECK(s[1].enabled);
    CHECK(!s[2].enabled);                               // "! share:" with a space
    CHECK_EQ(s[0].spec, "usb:SER:/a");
    CHECK_EQ(ImageLibSources::join(s), "!usb:SER:/a, http://x.example/l.csv, !share:/b");
}

static void testCap(void)
{
    std::string v;
    for(int i = 0; i < 10; i++) {
        char e[64];
        snprintf(e, sizeof(e), "%shttp://h%d.example/l.csv, ", (i == 0) ? "!" : "", i);
        v += e;
    }
    std::vector<ImageLibSource> s;
    std::vector<std::string> w;
    int n = ImageLibSources::parse(v, s, &w);
    CHECK(n == IMAGELIB_MAX_SOURCES);                   // the disabled one counts
    CHECK(!s[0].enabled);
    CHECK_EQ(s[7].url, "http://h7.example/l.csv");
    CHECK(w.size() == 2);
}

static void testDuplicates(void)
{
    std::vector<ImageLibSource> s;
    std::vector<std::string> w;
    int n = ImageLibSources::parse("http://a.example/l.csv, http://a.example/l.csv, share:/x, share:/x/", s, &w);
    CHECK(n == 2);
    CHECK(w.size() == 2);
}

static void testLongValue(void)
{
    // a 300+ character value: 8 long URLs
    std::string v;
    for(int i = 0; i < 8; i++) {
        char e[128];
        snprintf(e, sizeof(e), "https://mirror%d.example.org/some/long/path/to/the/atari/imagelist.csv", i);
        if(i) v += ", ";
        v += e;
    }
    CHECK(v.length() > 300);
    std::vector<ImageLibSource> s;
    CHECK(ImageLibSources::parse(v, s) == 8);
    CHECK_EQ(ImageLibSources::join(s), v);
}

static void testLocation(void)
{
    int type;
    std::string serial, path;
    CHECK(ImageLibSources::parseLocation("share:/a/b", type, serial, path));
    CHECK(type == IMAGELIB_TYPE_SHARE);
    CHECK_EQ(path, "/a/b");
    CHECK(ImageLibSources::parseLocation("share:a/b", type, serial, path));
    CHECK_EQ(path, "/a/b");                             // made absolute
    CHECK(ImageLibSources::parseLocation("share:", type, serial, path));
    CHECK_EQ(path, "/");                                // the share's root
    CHECK(ImageLibSources::parseLocation("usb:ABC123:/x%2Cy", type, serial, path));
    CHECK(type == IMAGELIB_TYPE_USB);
    CHECK_EQ(serial, "ABC123");
    CHECK_EQ(path, "/x,y");
    CHECK(!ImageLibSources::parseLocation("usb:AB/C:/x", type, serial, path));    // '/' in a serial
    CHECK(!ImageLibSources::parseLocation("usb:ABC", type, serial, path));
    CHECK(!ImageLibSources::parseLocation("share:/../etc", type, serial, path));
    CHECK(!ImageLibSources::parseLocation("share:/a/..", type, serial, path));
    CHECK(!ImageLibSources::parseLocation("http://x/y", type, serial, path));
}

static void testHelpers(void)
{
    CHECK_EQ(ImageLibSources::urlHost("http://user:pw@nas.lan:8080/a/b.csv"), "nas.lan:8080");
    CHECK_EQ(ImageLibSources::urlHost("https://joo.kie.sk"), "joo.kie.sk");
    CHECK_EQ(ImageLibSources::urlHost("nope"), "");
    CHECK_EQ(ImageLibSources::sanitizeId("a b/c:d"), "a_b_c_d");
    CHECK_EQ(ImageLibSources::shortHash("x"), ImageLibSources::shortHash("x"));
    CHECK(ImageLibSources::shortHash("x") != ImageLibSources::shortHash("y"));
    CHECK(ImageLibSources::shortHash("anything").length() == 6);

    // the web id contains the port as "_" (ids are file names)
    std::vector<ImageLibSource> s;
    ImageLibSources::parse("http://nas.lan:8080/l.csv", s);
    CHECK(s[0].id.compare(0, 13, "nas.lan_8080-") == 0);
}

// a fake sysfs: /sys/block/sda/device -> ../../devices/.../1-1.3/1-1.3:1.0/host0/target0:0:0/0:0:0:0
static void testUsbSerial(void)
{
    char tmpl[] = "/tmp/ce-sysfs-XXXXXX";
    char *root = mkdtemp(tmpl);
    CHECK(root != NULL);
    if(!root) return;

    std::string r = root;
    std::string usbdev = r + "/devices/platform/soc/3f980000.usb/usb1/1-1/1-1.3";
    std::string scsidev = usbdev + "/1-1.3:1.0/host0/target0:0:0/0:0:0:0";
    std::string cmd = "mkdir -p '" + scsidev + "' '" + r + "/block/sda' '" + r + "/block/mmcblk0' '" + r + "/devices/platform/emmc/mmc_host/mmc0/mmc0:aaaa'";
    CHECK(system(cmd.c_str()) == 0);

    FILE *f = fopen((usbdev + "/serial").c_str(), "w"); fputs("4C530001230615117324\n", f); fclose(f);
    f = fopen((usbdev + "/idVendor").c_str(), "w"); fputs("0781\n", f); fclose(f);
    // the SD card has a serial too, but it's no USB device (no idVendor)
    f = fopen((r + "/devices/platform/emmc/mmc_host/mmc0/mmc0:aaaa/serial").c_str(), "w"); fputs("0x1234\n", f); fclose(f);

    CHECK(symlink(scsidev.c_str(), (r + "/block/sda/device").c_str()) == 0);
    CHECK(symlink((r + "/devices/platform/emmc/mmc_host/mmc0/mmc0:aaaa").c_str(), (r + "/block/mmcblk0/device").c_str()) == 0);

    std::string serial;
    CHECK(usbSerialForBlockDevice("/dev/sda1", serial, root));
    CHECK_EQ(serial, "4C530001230615117324");
    CHECK(usbSerialForBlockDevice("/dev/sda", serial, root));
    CHECK(!usbSerialForBlockDevice("/dev/sdb1", serial, root));         // not there
    CHECK(!usbSerialForBlockDevice("/dev/mmcblk0p1", serial, root));    // not USB

    // a USB device without a serial number
    unlink((usbdev + "/serial").c_str());
    f = fopen((usbdev + "/serial").c_str(), "w"); fputs("\n", f); fclose(f);
    CHECK(!usbSerialForBlockDevice("/dev/sda1", serial, root));

    CHECK_EQ(usbBlockDiskName("/dev/sda1"), "sda");
    CHECK_EQ(usbBlockDiskName("/dev/sdab12"), "sdab");
    CHECK_EQ(usbBlockDiskName("/dev/mmcblk0p2"), "mmcblk0");
    CHECK_EQ(usbBlockDiskName("sdc"), "sdc");

    cmd = "rm -rf '" + r + "'";
    system(cmd.c_str());
}


static void testLocalLocation(void)
{
    int type; std::string serial, path;
    CHECK(ImageLibSources::parseLocation("local:/img_download", type, serial, path));
    CHECK(type == IMAGELIB_TYPE_LOCAL);
    CHECK_EQ(path, "/img_download");
    CHECK(ImageLibSources::parseLocation("local:", type, serial, path));
    CHECK_EQ(path, "/");
    CHECK(!ImageLibSources::parseLocation("local:/a/../../etc", type, serial, path));

    std::vector<ImageLibSource> v;
    CHECK(ImageLibSources::parse("local:/floppies, !local:/old", v) == 2);
    CHECK(v[0].type == IMAGELIB_TYPE_LOCAL && v[0].enabled);
    CHECK_EQ(v[0].label, "LOCAL /storage/floppies");
    CHECK(v[0].id.compare(0, 6, "local-") == 0);
    CHECK(!v[1].enabled);
    CHECK_EQ(ImageLibSources::join(v), "local:/floppies, !local:/old");
}

// fixtures made by run.sh: two.zip (737280 + 10 bytes), empty.zip, notzip.bin, cut.zip
static void testZipSize(void)
{
    int n = -1;
    CHECK(ZipUtil::unpackedSize("/tmp/ce-unit/two.zip", &n) == 737290);
    CHECK(n == 2);
    CHECK(ZipUtil::unpackedSize("/tmp/ce-unit/empty.zip", &n) == 0);
    CHECK(n == 0);
    CHECK(ZipUtil::unpackedSize("/tmp/ce-unit/notzip.bin") == -1);
    CHECK(ZipUtil::unpackedSize("/tmp/ce-unit/cut.zip") == -1);
    CHECK(ZipUtil::unpackedSize("/tmp/ce-unit/missing.zip") == -1);
}

static UnpackCacheEntry ent(const char *name, int64_t size, time_t used, bool inSlot)
{
    UnpackCacheEntry e;
    e.name = name; e.size = size; e.lastUsed = used; e.inSlot = inSlot;
    return e;
}

static void testEviction(void)
{
    std::vector<UnpackCacheEntry> c;
    c.push_back(ent("new",    2000, 300, false));
    c.push_back(ent("old",    1000, 100, false));
    c.push_back(ent("slot",   4000,  50, true));        // oldest, but in a slot
    c.push_back(ent("middle", 1500, 200, false));
    std::vector<std::string> ev;

    CHECK(UnpackCachePolicy::pickEvictions(c, 5000, 4000, ev) && ev.empty());     // fits already
    CHECK(UnpackCachePolicy::pickEvictions(c, 500, 1400, ev));                     // one old one is enough
    CHECK(ev.size() == 1 && ev[0] == "old");
    CHECK(UnpackCachePolicy::pickEvictions(c, 500, 2800, ev));                     // oldest first
    CHECK(ev.size() == 2 && ev[0] == "old" && ev[1] == "middle");
    CHECK(UnpackCachePolicy::pickEvictions(c, 0, 4500, ev) && ev.size() == 3);     // everything not in a slot
    CHECK(!UnpackCachePolicy::pickEvictions(c, 0, 4501, ev) && ev.empty());        // only the slot's would help: refused
}

int main(void)
{
    testParseBasic();
    testWhitespaceAndEmpty();
    testCommaDecoding();
    testUnknownAndInvalid();
    testDisabled();
    testCap();
    testDuplicates();
    testLongValue();
    testLocation();
    testHelpers();
    testUsbSerial();
    testLocalLocation();
    testZipSize();
    testEviction();

    printf("test_imagelib: %d checks, %d failed\n", checks, failures);
    return failures ? 1 : 0;
}
