tunnel: ${TUNNEL_NAME_MCP}
credentials-file: ${CLOUDFLARED_CREDENTIALS_FILE_MCP}

ingress:
 - hostname: ${PUBLIC_MCP_HOST}
   service: http://127.0.0.1:${MCP_PORT}
 - service: http_status:404
