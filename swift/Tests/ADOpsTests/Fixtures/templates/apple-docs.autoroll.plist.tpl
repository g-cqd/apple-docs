<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL_AUTOROLL}</string>
    <key>UserName</key>
    <string>${USER_NAME}</string>
    <key>GroupName</key>
    <string>staff</string>
    <!-- Weekly auto-roll: runs deploy-update with USE_SNAPSHOT=1, which git-pulls
         the latest code and applies a newer GitHub snapshot if one exists, else
         no-ops. Scheduled after the Sunday 06:00 UTC snapshot.yml build publishes
         (StartCalendarInterval is LOCAL time; tune AUTOROLL_WEEKDAY/HOUR in .env).
         No RunAtLoad / KeepAlive — it fires only on the calendar (launchd also
         runs a missed interval once the machine wakes). -->
    <key>ProgramArguments</key>
    <array>
        <string>${OPS_DIR}/bin/deploy-update.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${OPS_DIR}</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Weekday</key>
        <integer>${AUTOROLL_WEEKDAY}</integer>
        <key>Hour</key>
        <integer>${AUTOROLL_HOUR}</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <!-- A roll can run ~30 min (corpus swap + static rebuild); give launchd a
         generous window to let it exit cleanly if asked to stop. -->
    <key>ExitTimeOut</key>
    <integer>1800</integer>
    <key>StandardOutPath</key>
    <string>${OPS_DIR}/logs/apple-docs-autoroll.log</string>
    <key>StandardErrorPath</key>
    <string>${OPS_DIR}/logs/apple-docs-autoroll.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>/Users/${USER_NAME}</string>
        <key>USE_SNAPSHOT</key>
        <string>1</string>
    </dict>
</dict>
</plist>
