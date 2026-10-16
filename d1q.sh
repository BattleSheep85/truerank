#!/bin/sh
# usage: d1q.sh "SQL"
bws-exec FRANK_CLOUDFLARE_API_TOKEN -- sh -c 'CLOUDFLARE_API_TOKEN="$FRANK_CLOUDFLARE_API_TOKEN" npx wrangler d1 execute DB --remote --json --command "$0"' "$1" 2>/dev/null
