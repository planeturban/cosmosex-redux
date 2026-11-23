################################################################################
#
# ce-webui
#
################################################################################

CE_WEBUI_VERSION = 1.0
CE_WEBUI_SITE = $(BR2_EXTERNAL_COSMOSEX_PATH)/webui
CE_WEBUI_SITE_METHOD = local
CE_WEBUI_LICENSE = OFL-1.1 (fonts)
CE_WEBUI_LICENSE_FILES = fonts/LICENSE-barlow fonts/LICENSE-barlow-condensed fonts/LICENSE-jetbrains-mono
# The classic pages that stay come from the release's webroot; fonts are
# downloaded by ce-webui-fonts
CE_WEBUI_DEPENDENCIES = cosmosex ce-webui-fonts

CE_WEBUI_WEBROOT = $(TARGET_DIR)/usr/share/cosmosex/webroot

# The classic pages that stay: the config terminal (config.html, linked
# from the Config page as the fallback), credits, and the server-made
# status and debug reports (/app/status/, /app/debug/: templates/*.tpl),
# with the release's files they load. The rest of the release's web UI
# (old index, floppy, download, remote, screenshots, screen pages and
# their scripts) is replaced by the new UI: its old URLs redirect.
CE_WEBUI_CLASSIC_FILES = \
	config.html credits.html \
	templates/layout.tpl templates/status.tpl templates/debug.tpl \
	css/bootstrap.light.css css/style.css css/combined.css.gz \
	js/modernizr.custom.50426.js js/jquery.js js/zepto.js js/term.js \
	js/config.js img/ce_logo.png

define CE_WEBUI_INSTALL_TARGET_CMDS
	rm -rf $(CE_WEBUI_WEBROOT)
	mkdir -p $(CE_WEBUI_WEBROOT)/fonts
	for f in $(CE_WEBUI_CLASSIC_FILES); do \
		$(INSTALL) -D -m 0644 $(COSMOSEX_DIR)/app/webroot/$$f $(CE_WEBUI_WEBROOT)/$$f || exit 1; \
	done
	cd $(@D) && for f in index.html login.html css js fonts; do \
		cp -a $$f $(CE_WEBUI_WEBROOT)/ || exit 1; \
	done
	$(INSTALL) -m 0644 $(addprefix $(CE_WEBUI_FONTS_DIR)/,$(CE_WEBUI_FONTS_FILES)) $(CE_WEBUI_WEBROOT)/fonts/
	# Old URLs of pages the new UI replaces (floppy, download, remote,
	# screenshots, screen): redirects to its pages
	$(INSTALL) -m 0644 $(@D)/redirect/*.html $(CE_WEBUI_WEBROOT)/
endef

$(eval $(generic-package))
