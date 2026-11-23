################################################################################
#
# cosmosex
#
################################################################################

# ce-atari-releases, branch "stretch" (binaries built from ce-atari master 78a3d85)
COSMOSEX_VERSION = ec83f84e80fd37ccfc301183a10e5faad4d7869c
COSMOSEX_SITE = $(call github,atarijookie,ce-atari-releases,$(COSMOSEX_VERSION))
COSMOSEX_LICENSE = GPL-3.0
COSMOSEX_LICENSE_FILES = LICENSE

COSMOSEX_SEED_DIR = /usr/share/cosmosex/ce

# The app copies app/shellscripts/*.sh over the top-level scripts on every
# start unless /ce/.git exists (ce_main_app/update.cpp, createNewScripts()),
# and those copies are older. Stock /ce is a git checkout; an empty .git
# directory is enough to skip the copy.
#
# The release's three Raspberry Pi binaries are 32-bit (armhf) builds; they're
# left out and the ce-atari package installs builds from source instead.
define COSMOSEX_INSTALL_TARGET_CMDS
	rm -rf $(TARGET_DIR)$(COSMOSEX_SEED_DIR)
	mkdir -p $(TARGET_DIR)$(COSMOSEX_SEED_DIR)/.git
	rsync -a --exclude='.stamp_*' --exclude='.files-list*' \
		--exclude='.applied_patches_list' --exclude='.br_*' \
		--exclude='/app/cosmosex' --exclude='/update/flash_stm32' \
		--exclude='/update/flash_xilinx' \
		$(@D)/ $(TARGET_DIR)$(COSMOSEX_SEED_DIR)/
	chmod 0755 $(TARGET_DIR)$(COSMOSEX_SEED_DIR)/*.sh \
		$(TARGET_DIR)$(COSMOSEX_SEED_DIR)/update/*.sh
endef

$(eval $(generic-package))
