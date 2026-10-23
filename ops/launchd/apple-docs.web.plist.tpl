<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL_WEB}</string>
    <key>UserName</key>
    <string>${USER_NAME}</string>
    <key>GroupName</key>
    <string>staff</string>
    <key>ProgramArguments</key>
    <array>
        <string>${OPS_DIR}/bin/run-sandboxed.sh</string>
        <string>--port</string>
        <string>${WEB_BACKEND_PORT}</string>
        <string>--egress</string>
        <string>--</string>
        <string>${BUN_BIN}</string>
        <string>run</string>
        <string>${REPO_DIR}/cli.js</string>
        <string>web</string>
        <string>serve</string>
        <string>--port</string>
        <string>${WEB_BACKEND_PORT}</string>
        <string>--base-url</string>
        <string>https://${PUBLIC_WEB_HOST}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${REPO_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <!-- Restart on crash, but not after a clean graceful drain
             (SIGTERM-triggered exit 0). The lifecycle helper drains
             in-flight requests and exits 0 on success; we don't want launchd
             to immediately respawn during operator-initiated shutdowns. -->
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <!-- Allow up to 30 s for graceful drain after SIGTERM before launchd
         escalates to SIGKILL (default is 20 s, which would hard-kill
         in-flight HTTP requests). Matches gracefulShutdown's 30 s deadline. -->
    <key>ExitTimeOut</key>
    <integer>30</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${OPS_DIR}/logs/apple-docs-web.log</string>
    <key>StandardErrorPath</key>
    <string>${OPS_DIR}/logs/apple-docs-web.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>/Users/${USER_NAME}</string>
        <key>APPLE_DOCS_HOME</key>
        <string>${DATA_DIR}</string>
        <!-- Seatbelt sandbox wrapper inputs (ops/bin/run-sandboxed.sh). The
             wrapper confines this server after a compromise: no home-directory
             reads, writes only to the data/log/temp dirs, no spawning except
             sips. Set SANDBOX_SERVE=off in ops/.env to run unconfined; see
             docs/self-hosting.md "Sandbox". -->
        <key>SANDBOX_SERVE</key>
        <string>${SANDBOX_SERVE}</string>
        <key>REPO_DIR</key>
        <string>${REPO_DIR}</string>
        <key>OPS_DIR</key>
        <string>${OPS_DIR}</string>
        <key>DATA_DIR</key>
        <string>${DATA_DIR}</string>
        <key>BUN_BIN</key>
        <string>${BUN_BIN}</string>
        <!-- Split the streams: info/debug to StandardOutPath, warn/error to
             StandardErrorPath. Without this every request line lands in the
             .err.log (199 MB of `info` observed) and real failures are
             invisible. Safe here because these daemons serve HTTP; the
             stdio MCP server must NEVER set this — stdout is its protocol. -->
        <key>APPLE_DOCS_LOG_STDOUT</key>
        <string>1</string>
    </dict>
</dict>
</plist>
