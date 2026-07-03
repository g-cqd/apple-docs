tunnel: ${TUNNEL_NAME_MCP}
credentials-file: ${CLOUDFLARED_CREDENTIALS_FILE_MCP}

# Same h2 origin treatment as the web tunnel: cloudflared talks h2c
# to the local Caddy vhost, which then proxies HTTP/1.1 to the MCP
# Bun backend (Bun.serve has no h2c listener as of 1.3.14).
originRequest:
  http2Origin: true
  keepAliveConnections: 8
  keepAliveTimeout: 90s

ingress:
 - hostname: ${PUBLIC_MCP_HOST}
   service: http://127.0.0.1:${MCP_PORT}
 - service: http_status:404
