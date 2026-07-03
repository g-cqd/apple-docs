<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL_PROXY}</string>
    <key>UserName</key>
    <string>${USER_NAME}</string>
    <key>GroupName</key>
    <string>staff</string>
    <key>ProgramArguments</key>
    <array>
        <string>${OPS_DIR}/bin/run-proxy.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${OPS_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <!-- Restart on crash, but not after a clean exit (operator-initiated
             unload or signaled shutdown). -->
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <!-- Give Caddy time to finish in-flight responses before SIGKILL. -->
    <key>ExitTimeOut</key>
    <integer>30</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${OPS_DIR}/logs/apple-docs-proxy.log</string>
    <key>StandardErrorPath</key>
    <string>${OPS_DIR}/logs/apple-docs-proxy.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>/Users/${USER_NAME}</string>
    </dict>
</dict>
</plist>
