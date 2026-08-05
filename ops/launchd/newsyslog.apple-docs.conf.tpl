# newsyslog(8) drop-in — rotates the apple-docs daemon logs.
#
# launchd's StandardOutPath / StandardErrorPath append forever with no
# rotation of their own. Caddy rotates its own access logs, so those were
# fine; the daemon logs were not. Observed on the reference deployment
# before this existed: a 199 MB apple-docs-mcp.err.log, plus ~35 MB across
# the proxy and cloudflared error logs.
#
# newsyslog runs hourly from /System/Library/LaunchDaemons/com.apple.newsyslog.plist
# and reads every *.conf in /etc/newsyslog.d, so no extra daemon is needed.
#
# Columns: logfilename [owner:group] mode count size(KB) when flags
#   mode  644  — same perms launchd creates them with
#   count 7    — keep 7 generations
#   size  10240 — rotate past 10 MB
#   when  *    — size-triggered only, no calendar rotation
#   flags GN   — G: glob the path, N: don't signal any process
#
# `N` matters: these files are held open by launchd-managed processes and
# there is no pid file to signal. Rotation renames and gzips, and the
# daemons keep writing to the rotated inode until they restart — acceptable
# for logs that are already append-only diagnostics, and the weekly autoroll
# restart closes the loop.
${OPS_DIR}/logs/*.log    ${USER_NAME}:staff    644  7    10240  *  GN
${OPS_DIR}/logs/*.err.log ${USER_NAME}:staff   644  7    10240  *  GN
