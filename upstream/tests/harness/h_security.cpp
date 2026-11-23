// The tree's floppy/imagestorage.cpp and config/netsettings.cpp.
//
//   h_security image-path <storage folder> <image name>
//        ImageStorage::getImageLocalPath() as the web interface's "insert" and
//        "download" requests call it, with a USB drive at <storage folder>:
//        prints the path the app would open
//   h_security wifi <ssid> <password>
//        NetworkSettings::saveWpaSupplicant() and the settings dump the app
//        writes to its log at debug level (log: /tmp/h_security.log)
#include "common.h"
#include "translated/translatedhelper.h"
#include "translated/translateddisk.h"
#include "floppy/imagestorage.h"
#include "config/netsettings.h"
#include "periodicthread.h"

SharedObjects shared;

static std::string storage;
static char fakeTranslated[16];
TranslatedDisk *TranslatedDisk::getInstance(void) { return (TranslatedDisk *) fakeTranslated; }
void TranslatedDisk::mutexLock(void) { }
void TranslatedDisk::mutexUnlock(void) { }
bool TranslatedDisk::getPathToUsbDriveOrSharedDrive(std::string &hostRootPath)
{
    hostRootPath = storage;
    return true;
}

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    const char *what = argc > 1 ? argv[1] : "";

    if(strcmp(what, "image-path") == 0 && argc > 3) {
        harnessLog("/tmp/h_security.log");
        storage = argv[2];
        usleep(10000);                      // the storage path is looked up again after 3 s only: not at time 0
        ImageStorage is;
        std::string path;
        bool res = is.getImageLocalPath(argv[3], path);
        printf("result: %s\n", res ? "true" : "false");
        printf("path: %s\n", path.c_str());
        return 0;
    }

    if(strcmp(what, "wifi") == 0 && argc > 3) {
        harnessLog("/tmp/h_security.log", LOG_DEBUG);
        NetworkSettings ns;
        ns.wlan0.wpaSsid = argv[2];
        ns.wlan0.wpaPsk  = argv[3];
        ns.saveWpaSupplicant();
        ns.dumpSettings();
        return 0;
    }

    fprintf(stderr, "usage: see the top of h_security.cpp\n");
    return 99;
}
