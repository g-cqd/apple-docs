# apple-docs reference deployment — passwordless launchctl drop-in.
#
# Install:
#   ops/lib/render.sh ops/launchd/sudoers.apple-docs-launchctl.tpl \
#                     ops/launchd/sudoers.apple-docs-launchctl
#   sudo visudo -cf ops/launchd/sudoers.apple-docs-launchctl   # validate first
#   sudo install -m 0440 -o root -g wheel \
#        ops/launchd/sudoers.apple-docs-launchctl \
#        /etc/sudoers.d/apple-docs-launchctl
#
# This grants ${USER_NAME} the ability to bootstrap, bootout, kickstart, and
# print only the five labels below — nothing else gains elevated privilege.

Cmnd_Alias APPLE_DOCS_LAUNCHCTL = \
    /bin/launchctl bootstrap system /Library/LaunchDaemons/${LABEL_PREFIX}.proxy.plist, \
    /bin/launchctl bootstrap system /Library/LaunchDaemons/${LABEL_PREFIX}.web.plist, \
    /bin/launchctl bootstrap system /Library/LaunchDaemons/${LABEL_PREFIX}.mcp.plist, \
    /bin/launchctl bootstrap system /Library/LaunchDaemons/${LABEL_PREFIX}.cloudflared.web.plist, \
    /bin/launchctl bootstrap system /Library/LaunchDaemons/${LABEL_PREFIX}.cloudflared.mcp.plist, \
    /bin/launchctl bootout system/${LABEL_PREFIX}.proxy, \
    /bin/launchctl bootout system/${LABEL_PREFIX}.web, \
    /bin/launchctl bootout system/${LABEL_PREFIX}.mcp, \
    /bin/launchctl bootout system/${LABEL_PREFIX}.cloudflared.web, \
    /bin/launchctl bootout system/${LABEL_PREFIX}.cloudflared.mcp, \
    /bin/launchctl kickstart -k system/${LABEL_PREFIX}.proxy, \
    /bin/launchctl kickstart -k system/${LABEL_PREFIX}.web, \
    /bin/launchctl kickstart -k system/${LABEL_PREFIX}.mcp, \
    /bin/launchctl kickstart -k system/${LABEL_PREFIX}.cloudflared.web, \
    /bin/launchctl kickstart -k system/${LABEL_PREFIX}.cloudflared.mcp, \
    /bin/launchctl print system/${LABEL_PREFIX}.proxy, \
    /bin/launchctl print system/${LABEL_PREFIX}.web, \
    /bin/launchctl print system/${LABEL_PREFIX}.mcp, \
    /bin/launchctl print system/${LABEL_PREFIX}.cloudflared.web, \
    /bin/launchctl print system/${LABEL_PREFIX}.cloudflared.mcp

${USER_NAME} ALL=(root) NOPASSWD: APPLE_DOCS_LAUNCHCTL
