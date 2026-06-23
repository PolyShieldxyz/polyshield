#!/usr/bin/env bash
# Publish / un-draft a blog post WITHOUT rebuilding or redeploying the app.
#
# The post Markdown lives in packages/frontend/content/blog-md/<slug>.md and is bind-
# mounted read-only into the frontend container (see deploy/docker-compose.yml). To make
# a change live you only need the file present + a cache poke — this script does the poke.
#
# Typical flow on the deploy host:
#   1. Land the approved content (e.g. `git pull` the reviewed change, or scp the .md).
#      To go from draft -> live, set `published: true` in the file's frontmatter.
#   2. Run this script (optionally with the slug to target one post):
#        ./deploy/scripts/publish-blog.sh                       # refresh the whole blog
#        ./deploy/scripts/publish-blog.sh are-polymarket-trades-public
#
# Env (read from deploy/.env if present, or the environment):
#   SITE_URL                public base URL, e.g. https://polyshield.xyz  (or app/apex host)
#   BLOG_REVALIDATE_SECRET  shared secret, must match the frontend container's env
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="$here/../.env"
[ -f "$env_file" ] && set -a && . "$env_file" && set +a

SITE_URL="${SITE_URL:-${1:-}}"
SECRET="${BLOG_REVALIDATE_SECRET:-}"
SLUG="${1:-}"
# If $1 looks like a URL it's the site, not a slug.
case "$SLUG" in http*://*) SLUG="" ;; esac

if [ -z "${SITE_URL:-}" ] || [ -z "$SECRET" ]; then
  echo "ERROR: set SITE_URL and BLOG_REVALIDATE_SECRET (in deploy/.env or the environment)." >&2
  exit 1
fi

host="$(printf '%s' "$SITE_URL" | sed -E 's#^https?://##; s#/.*$##')"
body='{}'
[ -n "$SLUG" ] && body="$(printf '{"slug":"%s"}' "$SLUG")"

echo "→ revalidating ${SITE_URL}/api/revalidate ${SLUG:+(slug: $SLUG)}"
# Origin header satisfies the middleware /api CSRF guard; the secret is the real auth.
http_code="$(curl -sS -o /tmp/publish-blog.out -w '%{http_code}' \
  -X POST "${SITE_URL}/api/revalidate" \
  -H "Content-Type: application/json" \
  -H "Origin: https://${host}" \
  -H "x-revalidate-secret: ${SECRET}" \
  --data "$body")"

echo "  HTTP $http_code"
cat /tmp/publish-blog.out; echo
[ "$http_code" = "200" ] || { echo "FAILED" >&2; exit 1; }
echo "✓ published"
