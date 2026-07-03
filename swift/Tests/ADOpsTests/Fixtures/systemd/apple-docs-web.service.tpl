# apple-docs web server — systemd unit (Linux analogue of the launchd
# apple-docs.web.plist, RFC 0007 §4). Rendered by `ops render-all` from ops/.env
# with the SAME allowlisted-variable substitution as the macOS plists; every
# placeholder below is an allowlisted primary/derived var, so the rendered unit
# has no leftover placeholders. Install: cp the rendered file to
# /etc/systemd/system/, then `systemctl enable --now apple-docs-web`.
[Unit]
Description=apple-docs web server (${LABEL_WEB})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER_NAME}
WorkingDirectory=${REPO_DIR}
ExecStart=${BUN_BIN} run ${REPO_DIR}/cli.js web serve --port ${WEB_BACKEND_PORT} --base-url https://${PUBLIC_WEB_HOST}
Restart=on-failure
RestartSec=10
# Restart only on failure, matching the launchd KeepAlive/SuccessfulExit=false.
Environment=APPLE_DOCS_HOME=${DATA_DIR}
StandardOutput=append:${OPS_DIR}/logs/apple-docs-web.log
StandardError=append:${OPS_DIR}/logs/apple-docs-web.err.log

[Install]
WantedBy=multi-user.target
