/*
 * ce-screensaver: HDMI screen saver for the CosmosEx Buildroot image.
 *
 * After a while without activity, switches to its own virtual console in
 * graphics mode and shows the rainbow Atari logo (as on the original) that
 * spins around its vertical axis and bounces around the screen. Later it
 * switches the HDMI output off (FBIOBLANK; with hdmi_blanking=1 in
 * config.txt the monitor gets no signal and can go to standby). Any
 * activity returns to the console.
 *
 * Activity is:
 *   - input events on /dev/input/event* that we can read (the HDMI console's
 *     keyboard), and
 *   - USB keyboard/mouse/joystick use passed to the Atari: the CosmosEx app
 *     grabs those devices exclusively, so their events never reach us; the
 *     app's GET /api/v1/status reports when it last saw them (chips.ikbd_usb).
 *
 *   ce-screensaver [-l seconds] [-o seconds] [-t]
 *     -l  idle time until the logo appears (default 300; 0 = never)
 *     -o  idle time until the screen is switched off (default 1800; 0 = never)
 *     -t  test: start the logo at once
 */

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/fb.h>
#include <linux/input.h>
#include <linux/kd.h>
#include <linux/vt.h>
#include <math.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#define SAVER_VT    2       /* no getty there (inittab only runs one on tty1) */
#define MAX_INPUTS  32
#define FRAME_MS    40      /* 25 frames per second */

/* ------------------------------------------------------------- utilities */

static volatile sig_atomic_t quit;
static void on_signal(int sig) { (void) sig; quit = 1; }

static double now_s(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

/* ---------------------------------------------------------------- inputs */

static struct { int fd; char path[300]; } inputs[MAX_INPUTS];
static int n_inputs;

static int input_known(const char *path)
{
    for (int i = 0; i < n_inputs; i++)
        if (strcmp(inputs[i].path, path) == 0) return 1;
    return 0;
}

static void scan_inputs(void)
{
    DIR *d = opendir("/dev/input");
    if (!d) return;
    struct dirent *e;
    while ((e = readdir(d)) && n_inputs < MAX_INPUTS) {
        if (strncmp(e->d_name, "event", 5) != 0) continue;
        char path[300];
        snprintf(path, sizeof(path), "/dev/input/%s", e->d_name);
        if (input_known(path)) continue;
        int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
        if (fd < 0) continue;
        inputs[n_inputs].fd = fd;
        snprintf(inputs[n_inputs].path, sizeof(inputs[n_inputs].path), "%s", path);
        n_inputs++;
    }
    closedir(d);
}

static void drop_input(int i)
{
    close(inputs[i].fd);
    inputs[i] = inputs[--n_inputs];
}

/* Wait up to timeout_ms for input; returns 1 if a key/button/motion event came */
static int wait_input(int timeout_ms)
{
    struct pollfd pfd[MAX_INPUTS];
    for (int i = 0; i < n_inputs; i++) {
        pfd[i].fd = inputs[i].fd;
        pfd[i].events = POLLIN;
        pfd[i].revents = 0;
    }
    int r = poll(pfd, n_inputs, timeout_ms);
    if (r <= 0) return 0;

    int activity = 0;
    for (int i = n_inputs - 1; i >= 0; i--) {
        if (pfd[i].revents & (POLLERR | POLLHUP | POLLNVAL)) { drop_input(i); continue; }
        if (!(pfd[i].revents & POLLIN)) continue;
        struct input_event ev[16];
        ssize_t n;
        while ((n = read(inputs[i].fd, ev, sizeof(ev))) > 0) {
            for (size_t k = 0; k < (size_t) n / sizeof(ev[0]); k++)
                if (ev[k].type == EV_KEY || ev[k].type == EV_REL || ev[k].type == EV_ABS)
                    activity = 1;
        }
        if (n < 0 && errno == ENODEV) drop_input(i);
    }
    return activity;
}

/* -------------------------------------------- USB input used by the Atari */

/* Seconds since the app last saw USB keyboard/mouse/joystick input
 * (chips.ikbd_usb.ago_s from GET http://127.0.0.1/api/v1/status), or -1. */
static int usb_input_ago(void)
{
    int s = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (s < 0) return -1;
    struct timeval tv = { 1, 0 };
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons(80) };
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    int ago = -1;
    static char buf[16384];
    size_t len = 0;
    if (connect(s, (struct sockaddr *) &a, sizeof(a)) == 0) {
        const char *req = "GET /api/v1/status HTTP/1.0\r\nHost: localhost\r\n\r\n";
        if (write(s, req, strlen(req)) == (ssize_t) strlen(req)) {
            ssize_t n;
            while (len < sizeof(buf) - 1 && (n = read(s, buf + len, sizeof(buf) - 1 - len)) > 0)
                len += n;
        }
    }
    close(s);
    buf[len] = 0;

    char *p = strstr(buf, "\"ikbd_usb\":");
    if (p) {
        char *q = strstr(p, "\"ago_s\":");
        char *end = strchr(p, '}');
        if (q && (!end || q < end)) {
            q += 8;
            while (*q == ' ') q++;
            if (*q >= '0' && *q <= '9') ago = atoi(q);
        }
    }
    return ago;
}

/* ----------------------------------------------------------- framebuffer */

static int fbfd = -1;
static struct fb_var_screeninfo vinfo;
static struct fb_fix_screeninfo finfo;
static uint8_t *fb, *back;
static int bpp;                 /* bytes per pixel: 2 or 4 */

static uint32_t pack(int r, int g, int b)
{
    return ((uint32_t) (r >> (8 - vinfo.red.length))   << vinfo.red.offset)
         | ((uint32_t) (g >> (8 - vinfo.green.length)) << vinfo.green.offset)
         | ((uint32_t) (b >> (8 - vinfo.blue.length))  << vinfo.blue.offset);
}

static int fb_open(void)
{
    fbfd = open("/dev/fb0", O_RDWR | O_CLOEXEC);
    if (fbfd < 0) { perror("ce-screensaver: /dev/fb0"); return -1; }
    if (ioctl(fbfd, FBIOGET_VSCREENINFO, &vinfo) < 0 || ioctl(fbfd, FBIOGET_FSCREENINFO, &finfo) < 0) {
        perror("ce-screensaver: fb info");
        return -1;
    }
    if (vinfo.bits_per_pixel != 16 && vinfo.bits_per_pixel != 32) {
        fprintf(stderr, "ce-screensaver: %u bits per pixel not supported\n", vinfo.bits_per_pixel);
        return -1;
    }
    bpp = vinfo.bits_per_pixel / 8;
    fb = mmap(NULL, finfo.smem_len, PROT_READ | PROT_WRITE, MAP_SHARED, fbfd, 0);
    if (fb == MAP_FAILED) { perror("ce-screensaver: mmap"); return -1; }
    fb += vinfo.yoffset * finfo.line_length + vinfo.xoffset * bpp;
    back = calloc(1, (size_t) finfo.line_length * vinfo.yres);
    return back ? 0 : -1;
}

static void put_span(int y, int x0, int x1, uint32_t px)
{
    if (y < 0 || y >= (int) vinfo.yres) return;
    if (x0 < 0) x0 = 0;
    if (x1 >= (int) vinfo.xres) x1 = vinfo.xres - 1;
    uint8_t *row = back + (size_t) y * finfo.line_length;
    if (bpp == 4) {
        uint32_t *p = (uint32_t *) row;
        for (int x = x0; x <= x1; x++) p[x] = px;
    } else {
        uint16_t *p = (uint16_t *) row;
        for (int x = x0; x <= x1; x++) p[x] = (uint16_t) px;
    }
}

static void clear_rect(int x0, int y0, int x1, int y1)
{
    for (int y = y0; y <= y1; y++) put_span(y, x0, x1, 0);
}

static void copy_rect(int x0, int y0, int x1, int y1)
{
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 >= (int) vinfo.xres) x1 = vinfo.xres - 1;
    if (y1 >= (int) vinfo.yres) y1 = vinfo.yres - 1;
    if (x1 < x0 || y1 < y0) return;
    for (int y = y0; y <= y1; y++) {
        size_t off = (size_t) y * finfo.line_length + (size_t) x0 * bpp;
        memcpy(fb + off, back + off, (size_t) (x1 - x0 + 1) * bpp);
    }
}

/* ------------------------------------------------------------------ logo */

/* The Atari logo as on the original: the three-pronged symbol with a smooth
 * gradient from red (top) through yellow to sky blue (bottom). Shape and colours are tables in atari-logo.h (runs of
 * lit pixels per row, measured from a picture of the logo), scaled to the
 * screen; the spin squeezes the runs horizontally with cos(angle). */
#include "atari-logo.h"

#define LOGO_HALF_W (LOGO_SRC_HALF_W / 2.0 / LOGO_SRC_H)    /* in logo heights */

static void draw_logo(int cx, int cy, int h, double angle)
{
    double c = cos(angle);
    double shade = 0.45 + 0.55 * fabs(c);   /* darker when seen edge-on */
    double sx = c * h / (2.0 * LOGO_SRC_H); /* half source pixels -> screen pixels */

    for (int row = 0; row < h; row++) {
        int sr = (int) ((row + 0.5) * LOGO_SRC_H / h);
        if (sr >= LOGO_SRC_H) sr = LOGO_SRC_H - 1;
        int r = logo_rgb[sr * 3], g = logo_rgb[sr * 3 + 1], b = logo_rgb[sr * 3 + 2];
        uint32_t px = pack((int) (r * shade), (int) (g * shade), (int) (b * shade));
        int y = cy - h / 2 + row;
        for (int k = logo_row_start[sr]; k < logo_row_start[sr + 1]; k++) {
            double a = cx + logo_runs[2 * k] * sx, e = cx + logo_runs[2 * k + 1] * sx;
            if (a > e) { double tmp = a; a = e; e = tmp; }
            int x0 = (int) lround(a), x1 = (int) lround(e) - 1;
            if (x1 < x0) x1 = x0;               /* edge-on: a one-pixel line */
            put_span(y, x0, x1, px);
        }
    }
}

/* ------------------------------------------------------- virtual console */

static int tty0 = -1, ttys = -1, orig_vt = 1;
static int saver_on, screen_off;

static void saver_start(void)
{
    struct vt_stat vs;
    if (ioctl(tty0, VT_GETSTATE, &vs) == 0) orig_vt = vs.v_active;
    if (orig_vt == SAVER_VT) orig_vt = 1;
    ioctl(tty0, VT_ACTIVATE, SAVER_VT);
    ioctl(tty0, VT_WAITACTIVE, SAVER_VT);
    ttys = open("/dev/tty2", O_RDWR | O_CLOEXEC);
    if (ttys >= 0) ioctl(ttys, KDSETMODE, KD_GRAPHICS);
    memset(back, 0, (size_t) finfo.line_length * vinfo.yres);
    copy_rect(0, 0, vinfo.xres - 1, vinfo.yres - 1);
    saver_on = 1;
}

static void saver_stop(void)
{
    if (screen_off) {
        ioctl(fbfd, FBIOBLANK, FB_BLANK_UNBLANK);
        screen_off = 0;
    }
    if (ttys >= 0) {
        ioctl(ttys, KDSETMODE, KD_TEXT);
        close(ttys);
        ttys = -1;
    }
    ioctl(tty0, VT_ACTIVATE, orig_vt);   /* fbcon redraws the console */
    ioctl(tty0, VT_WAITACTIVE, orig_vt);
    saver_on = 0;
}

/* ------------------------------------------------------------------ main */

int main(int argc, char **argv)
{
    int idle_logo = 300, idle_off = 1800, test = 0, opt;
    while ((opt = getopt(argc, argv, "l:o:t")) != -1) {
        switch (opt) {
        case 'l': idle_logo = atoi(optarg); break;
        case 'o': idle_off = atoi(optarg); break;
        case 't': test = 1; break;
        default:
            fprintf(stderr, "usage: %s [-l seconds] [-o seconds] [-t]\n", argv[0]);
            return 2;
        }
    }
    if (fb_open() < 0) return 1;
    tty0 = open("/dev/tty0", O_RDWR | O_CLOEXEC);
    if (tty0 < 0) { perror("ce-screensaver: /dev/tty0"); return 1; }

    signal(SIGTERM, on_signal);
    signal(SIGINT, on_signal);
    signal(SIGHUP, on_signal);
    signal(SIGPIPE, SIG_IGN);

    double last_activity = test ? now_s() - idle_logo - 1 : now_s();
    double next_scan = 0, next_status = 0, saver_since = 0;

    int h = vinfo.yres / 4;
    if (h < 24) h = 24;
    int hw = (int) (LOGO_HALF_W * h) + 2, hh = h / 2 + 1;
    double x = vinfo.xres / 2.0, y = vinfo.yres / 3.0, angle = 0;
    double speed = vinfo.yres / 360.0;
    if (speed < 1) speed = 1;
    double vx = speed * 1.3, vy = speed;
    int px0 = 0, py0 = 0, px1 = -1, py1 = -1;   /* last drawn box */

    while (!quit) {
        double now = now_s();
        if (now >= next_scan) { scan_inputs(); next_scan = now + 5; }

        if (wait_input(saver_on && !screen_off ? FRAME_MS : 500))
            last_activity = now_s();

        now = now_s();
        if (now >= next_status && !test) {
            int ago = usb_input_ago();
            if (ago >= 0 && now - ago > last_activity) last_activity = now - ago;
            next_status = now + (saver_on ? 1 : 3);
        }
        if (test && saver_on && last_activity > saver_since) test = 0;

        double idle = now - last_activity;
        if (!saver_on) {
            if (idle_logo > 0 && idle >= idle_logo) {
                saver_start();
                saver_since = now;
                px1 = -1;
            } else if (idle_logo == 0 && idle_off > 0 && idle >= idle_off) {
                saver_start();
                saver_since = now;
            }
            continue;
        }

        if (last_activity > saver_since) {     /* someone's back */
            saver_stop();
            continue;
        }

        if (!screen_off && idle_off > 0 && idle >= idle_off) {
            memset(back, 0, (size_t) finfo.line_length * vinfo.yres);
            copy_rect(0, 0, vinfo.xres - 1, vinfo.yres - 1);
            ioctl(fbfd, FBIOBLANK, FB_BLANK_POWERDOWN);
            screen_off = 1;
            continue;
        }
        if (screen_off || idle_logo == 0) continue;

        /* move, bounce, spin */
        x += vx; y += vy;
        if (x - hw < 0)                   { x = hw;                   vx = fabs(vx); }
        if (x + hw >= (int) vinfo.xres)   { x = vinfo.xres - 1 - hw;  vx = -fabs(vx); }
        if (y - hh < 0)                   { y = hh;                   vy = fabs(vy); }
        if (y + hh >= (int) vinfo.yres)   { y = vinfo.yres - 1 - hh;  vy = -fabs(vy); }
        angle += 0.05;

        int nx0 = (int) x - hw, ny0 = (int) y - hh, nx1 = (int) x + hw, ny1 = (int) y + hh;
        if (px1 >= 0) clear_rect(px0, py0, px1, py1);
        draw_logo((int) x, (int) y, h, angle);
        if (px1 >= 0) {     /* copy the union of the old and new box */
            copy_rect(nx0 < px0 ? nx0 : px0, ny0 < py0 ? ny0 : py0,
                      nx1 > px1 ? nx1 : px1, ny1 > py1 ? ny1 : py1);
        } else {
            copy_rect(nx0, ny0, nx1, ny1);
        }
        px0 = nx0; py0 = ny0; px1 = nx1; py1 = ny1;
    }

    if (saver_on) saver_stop();
    return 0;
}
