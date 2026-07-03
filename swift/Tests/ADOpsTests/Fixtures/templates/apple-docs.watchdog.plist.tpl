<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL_WATCHDOG}</string>
    <key>UserName</key>
    <string>${USER_NAME}</string>
    <key>GroupName</key>
    <string>staff</string>
    <key>ProgramArguments</key>
    <array>
        <string>${OPS_DIR}/bin/watchdog.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${OPS_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <!-- Restart on crash; let a clean exit stay down. The watchdog is
             expected to run continuously, so a clean exit is operator intent. -->
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <!-- Watchdog uses small bash subprocesses; 15 s is enough for a clean exit. -->
    <key>ExitTimeOut</key>
    <integer>15</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${OPS_DIR}/logs/apple-docs-watchdog.log</string>
    <key>StandardErrorPath</key>
    <string>${OPS_DIR}/logs/apple-docs-watchdog.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>/Users/${USER_NAME}</string>
    </dict>
</dict>
</plist>
