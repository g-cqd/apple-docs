{
	admin ${CADDY_ADMIN_ADDR}
	auto_https off
}

# ----------------------------------------------------------------------------
# Web vhost — static site primary, Bun fallback for /api, /healthz, and on-
# demand /docs/* renders.
#
# The prebuilt site lives in ${STATIC_DIR} (rendered by `apple-docs web build
# --incremental`). Cloudflare and the local box both hit this vhost; the
# tunnel hands HTTP through to 127.0.0.1, so only public hostnames vary.
#
# Why static-first: the Bun process used to render every page on demand,
# which periodically wedged the event loop on giant frameworks (kernel,
# matter, swift, …) and forced the watchdog to kickstart it. With the
# prebuild, Caddy serves the HTML directly from disk in microseconds and the
# Bun process only handles the /api/* surface.
# ----------------------------------------------------------------------------
http://${PUBLIC_WEB_HOST}:${WEB_PORT}, http://127.0.0.1:${WEB_PORT} {
	bind 127.0.0.1

	root * ${STATIC_DIR}
	# Stock Caddy 2.x ships gzip + zstd; brotli requires a custom build with
	# the `caddyserver/cache-handler` / `dunglas/caddy-cbrotli` plugin. We
	# pre-compress `.br` sidecars at build time and Cloudflare re-compresses
	# at the edge anyway, so on-the-fly `br` here is unnecessary.
	encode zstd gzip

	log {
		output file ${OPS_DIR}/logs/caddy-access.log {
			roll_size 50MiB
			roll_keep 14
			roll_keep_for 720h
		}
		format json
	}

	# Cache-Control headers (apply to every response on the matching path,
	# including 304s). Cloudflare reads these to decide what to cache.
	@assets path /assets/* /worker/*
	header @assets Cache-Control "public, max-age=31536000, immutable"

	@hashed_data path_regexp /data/(search|frameworks)/.*\.[0-9a-f]{10}\..*
	header @hashed_data Cache-Control "public, max-age=31536000, immutable"

	@docs path /docs/*
	header @docs Cache-Control "public, max-age=86400, stale-while-revalidate=604800"

	@root path /
	header @root Cache-Control "public, max-age=300, stale-while-revalidate=86400"

	# Live endpoints — always go to Bun. Health-probe `/healthz` so Caddy
	# pulls Bun out of rotation if the event loop wedges (cheaper now that
	# Bun only handles /api/*, but still useful as a backstop).
	@live path /api/* /healthz /data/search/search-manifest.json
	handle @live {
		reverse_proxy 127.0.0.1:${WEB_BACKEND_PORT} {
			header_up Accept-Encoding identity
			health_uri /healthz
			health_interval 5s
			health_timeout 5s
			health_passes 2
			health_fails 3
			fail_duration 30s
			max_fails 1
		}
	}

	# /docs/* misses fall through to Bun's on-demand fetch path. New Apple
	# docs that aren't in the prebuilt corpus yet keep working — Bun fetches,
	# persists, and responds, then the next `apple-docs web build
	# --incremental` materialises a static copy.
	@docs_miss {
		path /docs/*
		not file {
			try_files {path} {path}/index.html
		}
	}
	handle @docs_miss {
		reverse_proxy 127.0.0.1:${WEB_BACKEND_PORT} {
			header_up Accept-Encoding identity
		}
	}

	# Default route: serve from disk. `try_files` resolves clean URLs like
	# `/docs/swiftui/` to `/docs/swiftui/index.html`.
	#
	# `precompressed` accepts `br` even though stock Caddy can't *encode*
	# brotli: it just ships the `.br` sidecar verbatim when the client
	# advertises `br` in Accept-Encoding. Brotli decoding is universal in
	# every modern client; only the encoder requires a plugin.
	handle {
		try_files {path} {path}/index.html
		file_server {
			precompressed br zstd gzip
			index index.html
		}
	}
}

# ----------------------------------------------------------------------------
# MCP vhost — unchanged. The MCP server is small and stateless; static hosting
# does not apply.
# ----------------------------------------------------------------------------
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
