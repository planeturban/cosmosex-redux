################################################################################
#
# ce-atari
#
################################################################################

# "master": the source of the stretch release (same commit date, 2019-08-15)
CE_ATARI_VERSION = 78a3d85de852ec20776061b130058f67f5749ca8
CE_ATARI_SITE = $(call github,atarijookie,ce-atari,$(CE_ATARI_VERSION))
# app: BSD-2-Clause; bundled bcm2835 (statically linked): GPL-3.0+;
# bundled cJSON: MIT
CE_ATARI_LICENSE = BSD-2-Clause, GPL-3.0+ (bcm2835), MIT (cJSON)
CE_ATARI_LICENSE_FILES = ce_main_app/license.txt
CE_ATARI_DEPENDENCIES = cosmosex libcurl openssl civetweb

CE_ATARI_APP_DIR = $(@D)/ce_main_app
CE_ATARI_BCM_DIR = $(@D)/build-bcm2835
CE_ATARI_SEED_DIR = $(TARGET_DIR)$(COSMOSEX_SEED_DIR)

# bcm2835 1.55, bundled in ce_main_app/lib (version from .install-bcm2835.sh)
define CE_ATARI_BUILD_BCM2835
	rm -rf $(CE_ATARI_BCM_DIR)
	mkdir -p $(CE_ATARI_BCM_DIR)
	tar xzf $(CE_ATARI_APP_DIR)/lib/bcm2835-1.55.tar.gz -C $(CE_ATARI_BCM_DIR) --strip-components=1
	$(TARGET_CC) $(TARGET_CFLAGS) -c $(CE_ATARI_BCM_DIR)/src/bcm2835.c -o $(CE_ATARI_BCM_DIR)/bcm2835.o
	$(TARGET_AR) rcs $(CE_ATARI_APP_DIR)/lib/libbcm2835.a $(CE_ATARI_BCM_DIR)/bcm2835.o
endef

# civetweb: Buildroot's package (1.16 with its security fixes, as a
# shared library with the C++ wrapper), not the tree's bundled 1.7 from 2014
# (ce_main_app/lib/civetweb-master.zip); the app's webserver/civetweb.h and
# CivetServer.h include the package's headers (patch 0033).

# Web UI directory (patch 0008): image-owned, so /ce updates don't replace
# the new UI with the release's old one (package ce-webui installs it)
CE_ATARI_WEBROOT = /usr/share/cosmosex/webroot/

# The app's web server listens here only (patch 0050); the network reaches
# nginx on port 80, which passes everything on (/etc/nginx/nginx.conf)
CE_ATARI_WEBLISTEN = 127.0.0.1:8081

# Floppy image lists, one per web source of IMAGELIB_SOURCES (patch 0011):
# on the data partition, off the read-only root
CE_ATARI_IMAGELIST_CACHE_DIR = /data/imagelists

# The app reports its build date (__DATE__) as its version. Build it with the
# source commit's date (2019-08-15), as in the release, not today's.
CE_ATARI_SOURCE_DATE_EPOCH = 1565893006

# The app's own makefile, built as for Raspbian Stretch (DISTRO=stretch:
# -DDISTRO_RASPBIAN -DDISTRO_STRETCH) but without its hardcoded ARMv6 flags.
define CE_ATARI_BUILD_APP
	$(TARGET_MAKE_ENV) SOURCE_DATE_EPOCH=$(CE_ATARI_SOURCE_DATE_EPOCH) \
		$(MAKE) -C $(CE_ATARI_APP_DIR) V=1 \
		CC="$(TARGET_CC)" CXX="$(TARGET_CXX)" DISTRO=stretch \
		CPU_FLAGS="$(TARGET_CFLAGS) -I$(CE_ATARI_BCM_DIR)/src -DCE_WEBROOT='\"$(CE_ATARI_WEBROOT)\"' -DCE_WEBLISTEN='\"$(CE_ATARI_WEBLISTEN)\"' -DIMAGELIST_CACHE_DIR='\"$(CE_ATARI_IMAGELIST_CACHE_DIR)\"'"
endef

define CE_ATARI_BUILD_FLASHERS
	cd $(@D)/flash_stm32 && $(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) \
		-I$(CE_ATARI_BCM_DIR)/src -o flash_stm32 \
		parsers/binary.c parsers/hex.c main.c serial_common.c \
		serial_posix.c stm32.c utils.c gpio.c \
		-L$(CE_ATARI_APP_DIR)/lib -lbcm2835
	cd $(@D)/flash_xilinx && $(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) \
		-I$(CE_ATARI_BCM_DIR)/src -o flash_xilinx \
		gpio.c micro.c lenval.c ports.c \
		-L$(CE_ATARI_APP_DIR)/lib -lbcm2835 -lrt
endef

define CE_ATARI_BUILD_CMDS
	$(CE_ATARI_BUILD_BCM2835)
	$(CE_ATARI_BUILD_APP)
	$(CE_ATARI_BUILD_FLASHERS)
endef

# The ST's driver CE_DD.PRG (st/, built from this source with the patches by
# tools/m68k/build-st.sh: needs an m68k cross compiler, so it isn't built here).
# Patch 0046: it asks the CosmosEx once a second, and resets the ST when asked.

# Overwrite the release's 32-bit binaries in the /ce seed (the cosmosex
# package leaves them out).
define CE_ATARI_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(CE_ATARI_APP_DIR)/cosmosex_raspbian_stretch \
		$(CE_ATARI_SEED_DIR)/app/cosmosex
	$(INSTALL) -D -m 0755 $(@D)/flash_stm32/flash_stm32 \
		$(CE_ATARI_SEED_DIR)/update/flash_stm32
	$(INSTALL) -D -m 0755 $(@D)/flash_xilinx/flash_xilinx \
		$(CE_ATARI_SEED_DIR)/update/flash_xilinx
	$(INSTALL) -D -m 0644 $(CE_ATARI_PKGDIR)/st/ce_dd.prg \
		$(CE_ATARI_SEED_DIR)/app/configdrive/drivers/ce_dd.prg
	# the app's licence (BSD 2-clause) asks for its text to go along with binaries
	$(INSTALL) -D -m 0644 $(@D)/ce_main_app/license.txt \
		$(TARGET_DIR)/usr/share/licenses/ce_main_app/license.txt
endef

$(eval $(generic-package))
