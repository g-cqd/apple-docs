tunnel: ${TUNNEL_NAME_WEB}
credentials-file: ${CLOUDFLARED_CREDENTIALS_FILE_WEB}

ingress:
 - hostname: ${PUBLIC_WEB_HOST}
   service: http://127.0.0.1:${WEB_PORT}
 - service: http_status:404
