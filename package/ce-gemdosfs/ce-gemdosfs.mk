################################################################################
#
# ce-gemdosfs
#
################################################################################

CE_GEMDOSFS_VERSION = 1.0
CE_GEMDOSFS_SITE = $(BR2_EXTERNAL_COSMOSEX_PATH)/package/ce-gemdosfs/src
CE_GEMDOSFS_SITE_METHOD = local
CE_GEMDOSFS_LICENSE = GPL-2.0+
CE_GEMDOSFS_DEPENDENCIES = libfuse3 host-pkgconf

define CE_GEMDOSFS_BUILD_CMDS
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) -O2 -Wall -Wextra \
		`$(PKG_CONFIG_HOST_BINARY) --cflags fuse3` \
		-o $(@D)/ce-gemdosfs $(@D)/ce-gemdosfs.c \
		`$(PKG_CONFIG_HOST_BINARY) --libs fuse3`
endef

define CE_GEMDOSFS_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/ce-gemdosfs $(TARGET_DIR)/usr/sbin/ce-gemdosfs
endef

$(eval $(generic-package))
