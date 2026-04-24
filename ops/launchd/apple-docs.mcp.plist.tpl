<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL_MCP}</string>
    <key>UserName</key>
    <string>${USER_NAME}</string>
    <key>GroupName</key>
    <string>staff</string>
    <key>ProgramArguments</key>
    <array>
        <string>${BUN_BIN}</string>
        <string>run</string>
        <string>${REPO_DIR}/cli.js</string>
        <string>mcp</string>
        <string>serve</string>
        <string>--port</string>
        <string>${MCP_BACKEND_PORT}</string>
        <string>--host</string>
        <string>127.0.0.1</string>
        <string>--allow-origin</string>
        <string>https://${PUBLIC_MCP_HOST}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${REPO_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${OPS_DIR}/logs/apple-docs-mcp.log</string>
    <key>StandardErrorPath</key>
    <string>${OPS_DIR}/logs/apple-docs-mcp.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>/Users/${USER_NAME}</string>
        <key>APPLE_DOCS_HOME</key>
        <string>${DATA_DIR}</string>
        <!-- Cap concurrent heavy tool calls (search_docs, read_doc, browse)
             so the Bun event loop stays responsive for initialize / ping /
             tools/list under load. With the reader pool enabled below, heavy
             SQL work runs on worker threads, so permits can be raised to
             match the worker count rather than serializing on the main loop. -->
        <key>APPLE_DOCS_MCP_CONCURRENCY</key>
        <string>8</string>
        <key>APPLE_DOCS_MCP_QUEUE</key>
        <string>64</string>
        <!-- Turn on the worker-thread reader pool: each worker opens its own
             bun:sqlite handle (read-only, WAL) so FTS / trigram / body /
             fuzzy tiers parallelize instead of blocking the Bun event loop. -->
        <key>APPLE_DOCS_MCP_READERS</key>
        <string>on</string>
        <!-- Explicit worker count. Leave unset to let the pool auto-size
             (availableParallelism() - 2, capped at 12). 8 matches the heavy
             concurrency permit ceiling above. -->
        <key>APPLE_DOCS_MCP_READER_WORKERS</key>
        <string>8</string>
        <!-- Surface cache + concurrency + reader-pool counters on /healthz
             for ops probes. -->
        <key>APPLE_DOCS_MCP_CACHE_STATS</key>
        <string>1</string>
    </dict>
</dict>
</plist>
