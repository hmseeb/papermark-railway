#!/bin/sh
# Boot Papermark on Railway: point the build-time host placeholder at this
# deploy's domain, apply migrations, serve on both IP stacks.
set -eu

PLACEHOLDER=papermark-railway-host.invalid
APP_HOST="${APP_HOST:-${RAILWAY_PUBLIC_DOMAIN:-}}"
if [ -z "$APP_HOST" ]; then
  echo "boot: no public domain. Generate one for this service (Settings > Networking) or set APP_HOST, then redeploy." >&2
  exit 1
fi

# NEXT_PUBLIC_* values are compiled into .next as the placeholder host.
# The marker holds whatever host the files carry now, so changing APP_HOST
# (say, to a custom domain) and restarting rewrites from that, not from the
# placeholder.
marker=/app/.next/.railway-host
current=$(cat "$marker" 2>/dev/null || echo "$PLACEHOLDER")
if [ "$current" != "$APP_HOST" ]; then
  pattern=$(printf '%s' "$current" | sed 's/[.]/\\./g')
  grep -rlF "$current" /app/.next | xargs -r sed -i "s#${pattern}#${APP_HOST}#g"
  printf '%s' "$APP_HOST" > "$marker"
  echo "boot: app host is ${APP_HOST}"
fi

export NEXTAUTH_URL="${NEXTAUTH_URL:-https://${APP_HOST}}"
export NEXT_PUBLIC_BASE_URL="https://${APP_HOST}"
export NEXT_PUBLIC_MARKETING_URL="https://${APP_HOST}"
export NEXT_PUBLIC_APP_BASE_HOST="${APP_HOST}"

cd /app
node_modules/.bin/prisma migrate deploy
exec node_modules/.bin/next start -H :: -p "${PORT:-3000}"
