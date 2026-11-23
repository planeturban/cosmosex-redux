// The tree's devfinder.cpp, with the translated disk, the SCSI/ACSI layer and
// the mounter replaced by stubs that print what they were asked to do.
//
//   h_devfinder <step> ...     a step is "scan" (one DevFinder::lookForDevChanges(),
//                              as the app does when /dev/disk changes) or a
//                              shell command (to add and remove device links)
#include "common.h"
#include "translated/translatedhelper.h"
#include "translated/translateddisk.h"
#include "native/scsi.h"
#include "mounter.h"
#include "periodicthread.h"
#include "devfinder.h"

SharedObjects shared;

static const char *actionName(int a)
{
    return a == MOUNTER_ACTION_MOUNT ? "MOUNT" : a == MOUNTER_ACTION_UMOUNT ? "UMOUNT" : "OTHER";
}

int Mounter::add(TMounterRequest &tmr)
{
    printf("mounter: %s %s %s\n", actionName(tmr.action), tmr.devicePath.c_str(), tmr.mountDir.c_str());
    return 1;
}

static char fakeTranslated[16], fakeScsi[16];       // never looked into: the stubs below don't use "this"
TranslatedDisk *TranslatedDisk::getInstance(void) { return (TranslatedDisk *) fakeTranslated; }
void TranslatedDisk::mutexLock(void) { }
void TranslatedDisk::mutexUnlock(void) { }
bool TranslatedDisk::attachToHostPath(std::string hostRootPath, int translatedType, std::string devicePath)
{
    printf("translated: attach %s (%s)\n", hostRootPath.c_str(), devicePath.c_str());
    return true;
}
void TranslatedDisk::detachFromHostPath(std::string hostRootPath)
{
    printf("translated: detach %s\n", hostRootPath.c_str());
}
bool Scsi::attachToHostPath(std::string hostPath, int hostSourceType, int accessType)
{
    printf("raw: attach %s\n", hostPath.c_str());
    return true;
}
void Scsi::dettachFromHostPath(std::string hostPath) { }

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    harnessLog("/tmp/h_devfinder.log");
    memset(&shared, 0, sizeof(shared));
    pthread_mutex_init(&shared.mtxScsi, NULL);
    shared.scsi = (Scsi *) fakeScsi;
    shared.mountRawNotTrans = false;                // USB drives as translated drives (the default)

    DevFinder finder;
    for(int i = 1; i < argc; i++) {
        if(strcmp(argv[i], "scan") == 0) {
            printf("-- scan\n");
            finder.lookForDevChanges();
        } else if(system(argv[i]) != 0) {
            printf("step failed: %s\n", argv[i]);
            return 99;
        }
    }
    return 0;
}
