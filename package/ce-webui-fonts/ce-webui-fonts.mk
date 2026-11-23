################################################################################
#
# ce-webui-fonts
#
################################################################################

# Fontsource woff2 files, Latin subset, static weights (Barlow and Barlow
# Condensed have no variable version). Download only: ce-webui installs them.
CE_WEBUI_FONTS_VERSION = 5.2.8
CE_WEBUI_FONTS_LIST = \
	barlow:400 barlow:500 barlow:600 \
	barlow-condensed:500 barlow-condensed:600 barlow-condensed:700 \
	jetbrains-mono:400 jetbrains-mono:500
CE_WEBUI_FONTS_FILE = $(firstword $(subst :, ,$(1)))-latin-$(lastword $(subst :, ,$(1)))-normal.woff2
CE_WEBUI_FONTS_URL = https://cdn.jsdelivr.net/npm/@fontsource/$(firstword $(subst :, ,$(1)))@$(CE_WEBUI_FONTS_VERSION)/files/$(call CE_WEBUI_FONTS_FILE,$(1))
CE_WEBUI_FONTS_FILES = $(foreach f,$(CE_WEBUI_FONTS_LIST),$(call CE_WEBUI_FONTS_FILE,$(f)))

CE_WEBUI_FONTS_SITE = https://cdn.jsdelivr.net/npm/@fontsource/barlow@$(CE_WEBUI_FONTS_VERSION)/files
CE_WEBUI_FONTS_SOURCE = barlow-latin-400-normal.woff2
CE_WEBUI_FONTS_EXTRA_DOWNLOADS = $(foreach f,$(filter-out barlow:400,$(CE_WEBUI_FONTS_LIST)),$(call CE_WEBUI_FONTS_URL,$(f)))
CE_WEBUI_FONTS_LICENSE = OFL-1.1
CE_WEBUI_FONTS_LICENSE_FILES = LICENSE-barlow LICENSE-barlow-condensed LICENSE-jetbrains-mono
CE_WEBUI_FONTS_INSTALL_TARGET = NO

# Nothing to extract: copy the font files (and the licenses kept next to the
# web UI source) into the build directory.
define CE_WEBUI_FONTS_EXTRACT_CMDS
	$(foreach f,$(CE_WEBUI_FONTS_FILES),cp $(CE_WEBUI_FONTS_DL_DIR)/$(f) $(@D)/
	)
	cp $(BR2_EXTERNAL_COSMOSEX_PATH)/webui/fonts/LICENSE-* $(@D)/
endef

$(eval $(generic-package))
