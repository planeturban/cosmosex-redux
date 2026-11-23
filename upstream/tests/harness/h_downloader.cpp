// The tree's downloader.cpp, run as the app runs it (its own thread, a
// request added to its queue).
//
//   h_downloader <url> <folder to download into>
//
// Prints how the download ended; the file (if any) is in the folder.
#include "common.h"
#include "downloader.h"
#include "version.h"

// what the "report versions" request (not used here) takes from the app
RPiConfig rpiConfig;
const char *distroString = "test";
void Version::getAppVersion(char *bfr) { strcpy(bfr, "test"); }

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    if(argc < 3) return 99;
    harnessLog("/tmp/h_downloader.log");

    Downloader::initBeforeThreads();
    pthread_t thread;
    pthread_create(&thread, NULL, downloadThreadCode, NULL);

    volatile BYTE status = DWNSTATUS_WAITING;
    TDownloadRequest tdr;
    tdr.srcUrl       = argv[1];
    tdr.dstDir       = argv[2];
    tdr.downloadType = DWNTYPE_FLOPPYIMG;
    tdr.checksum     = 0;                   // 0: no checksum to compare (as for a file outside the lists)
    tdr.pStatusByte  = &status;
    Downloader::add(tdr);

    for(int i = 0; i < 200 && status != DWNSTATUS_DOWNLOAD_OK && status != DWNSTATUS_DOWNLOAD_FAIL; i++) {
        usleep(100000);
    }
    printf("status: %s\n", status == DWNSTATUS_DOWNLOAD_OK ? "ok" : status == DWNSTATUS_DOWNLOAD_FAIL ? "failed" : "timed out");

    Downloader::stop();
    pthread_join(thread, NULL);
    return 0;
}
