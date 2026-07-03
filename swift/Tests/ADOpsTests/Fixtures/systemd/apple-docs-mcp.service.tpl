# apple-docs MCP server — systemd unit (Linux analogue of the launchd
# apple-docs.mcp.plist, RFC 0007 §4). Rendered by `ops render-all` from ops/.env
# with the SAME allowlisted-variable substitution as the macOS plists; every
# placeholder below is an allowlisted primary/derived var, so the rendered unit
# has no leftover placeholders. Install: cp the rendered file to
# /etc/systemd/system/, then `systemctl enable --now apple-docs-mcp`.
[Unit]
Description=apple-docs MCP server (${LABEL_MCP})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER_NAME}
WorkingDirectory=${REPO_DIR}
ExecStart=${BUN_BIN} run ${REPO_DIR}/cli.js mcp serve --port ${MCP_BACKEND_PORT} --host 127.0.0.1 --allow-origin https://${PUBLIC_MCP_HOST}
Restart=on-failure
RestartSec=10
Environment=APPLE_DOCS_HOME=${DATA_DIR}
Environment=APPLE_DOCS_MCP_CACHE_SCALE=${APPLE_DOCS_MCP_CACHE_SCALE}
StandardOutput=append:${OPS_DIR}/logs/apple-docs-mcp.log
StandardError=append:${OPS_DIR}/logs/apple-docs-mcp.err.log

[Install]
WantedBy=multi-user.target
