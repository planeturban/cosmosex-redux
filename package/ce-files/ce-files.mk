################################################################################
#
# ce-files
#
################################################################################

CE_FILES_VERSION = 1.0
CE_FILES_SITE = $(BR2_EXTERNAL_COSMOSEX_PATH)/package/ce-files/src
CE_FILES_SITE_METHOD = local
CE_FILES_LICENSE = GPL-2.0+
CE_FILES_DEPENDENCIES = zlib

define CE_FILES_BUILD_CMDS
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) -O2 -Wall -Wextra \
		-o $(@D)/ce-files $(@D)/ce-files.c -lz
endef

define CE_FILES_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/ce-files $(TARGET_DIR)/usr/sbin/ce-files
endef

$(eval $(generic-package))
