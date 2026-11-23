// For the harnesses: the app's headers with everything reachable, and the
// globals the app's main.cpp has.
#ifndef HARNESS_COMMON_H
#define HARNESS_COMMON_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <signal.h>
#include <pthread.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <string>
#include <vector>
#include <map>
#include <list>
#include <queue>
#include <sstream>
#include <iostream>
#include <algorithm>

// the functions under test are often private
#define private public
#define protected public

#include "global.h"
#include "debug.h"
#include "utils.h"

TFlags flags;
volatile sig_atomic_t sigintReceived = 0;

// log to a file of the test's own, at the app's default level (or another)
static void harnessLog(const char *path, int level = LOG_ERROR)
{
    flags.logLevel = level;
    unlink(path);
    Debug::setLogFile(path);
}

#endif
