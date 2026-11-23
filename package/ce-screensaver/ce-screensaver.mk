################################################################################
#
# ce-screensaver
#
################################################################################

CE_SCREENSAVER_VERSION = 1.0
CE_SCREENSAVER_SITE = $(BR2_EXTERNAL_COSMOSEX_PATH)/package/ce-screensaver/src
CE_SCREENSAVER_SITE_METHOD = local
CE_SCREENSAVER_LICENSE = GPL-2.0+

define CE_SCREENSAVER_BUILD_CMDS
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) -O2 -Wall -Wextra \
		-o $(@D)/ce-screensaver $(@D)/ce-screensaver.c -lm
endef

define CE_SCREENSAVER_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/ce-screensaver $(TARGET_DIR)/usr/sbin/ce-screensaver
endef

$(eval $(generic-package))
