################################################################################
#
# ce-tryboot
#
################################################################################

CE_TRYBOOT_VERSION = 1.0
CE_TRYBOOT_SITE = $(BR2_EXTERNAL_COSMOSEX_PATH)/package/ce-tryboot/src
CE_TRYBOOT_SITE_METHOD = local
CE_TRYBOOT_LICENSE = GPL-3.0+

define CE_TRYBOOT_BUILD_CMDS
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) -O2 -Wall -Wextra \
		-o $(@D)/ce-tryboot $(@D)/ce-tryboot.c
endef

define CE_TRYBOOT_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0755 $(@D)/ce-tryboot $(TARGET_DIR)/usr/sbin/ce-tryboot
endef

$(eval $(generic-package))
