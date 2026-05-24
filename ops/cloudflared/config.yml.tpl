tunnel: ${TUNNEL_NAME_WEB}
credentials-file: ${CLOUDFLARED_CREDENTIALS_FILE_WEB}

# Speak HTTP/2 cleartext to the local Caddy. Each tunnel-edge QUIC
# connection (4 by default) multiplexes concurrent requests onto a
# single Caddy connection instead of holding a pool of HTTP/1.1
# sockets — eliminates head-of-line blocking on /api/search bursts.
# keepAliveConnections drops from the 100-conn HTTP/1.1 default to
# a small pool sized for h2 multiplexing.
originRequest:
  http2Origin: true
  keepAliveConnections: 16
  keepAliveTimeout: 90s

ingress:
 - hostname: ${PUBLIC_WEB_HOST}
   service: http://127.0.0.1:${WEB_PORT}
 - service: http_status:404
