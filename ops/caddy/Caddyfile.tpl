{
	admin ${CADDY_ADMIN_ADDR}
	auto_https off
}

http://${PUBLIC_WEB_HOST}:${WEB_PORT}, http://127.0.0.1:${WEB_PORT} {
	bind 127.0.0.1

	reverse_proxy 127.0.0.1:${WEB_BACKEND_PORT} {
		header_up Accept-Encoding identity
		health_uri /
		health_interval 5s
		health_timeout 2s
		health_passes 2
		health_fails 2
		fail_duration 10s
		max_fails 1
	}
}

http://${PUBLIC_MCP_HOST}:${MCP_PORT}, http://127.0.0.1:${MCP_PORT} {
	bind 127.0.0.1

	reverse_proxy 127.0.0.1:${MCP_BACKEND_PORT} {
		header_up Accept-Encoding identity
		# Health probe runs on the same Bun event loop as tool calls, so a 2s
		# timeout is too tight when a heavy `search_docs` is in-flight. The
		# app-level scheduler keeps /healthz unblocked, but we still want
		# headroom for first-call warmups and occasional SQLite fsyncs.
		health_uri /healthz
		health_interval 10s
		health_timeout 5s
		health_passes 1
		health_fails 3
		# Treat the origin as down for only a few seconds if a probe trips —
		# a wider window causes user-facing outages for every burst.
		fail_duration 5s
		max_fails 3
		# Keep long-polled SSE (`GET /mcp`) alive.
		stream_timeout 24h
		stream_close_delay 5m
	}
}
