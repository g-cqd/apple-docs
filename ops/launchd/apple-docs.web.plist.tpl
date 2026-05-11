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
    </dict>
</dict>
</plist>
