#!/usr/bin/env bash
# Deploy the time tracker. Env-var driven so a deploy is identical whether CI
# runs it on a self-hosted runner or you run it by hand on the box.
#
# Idempotent: materializes the app env file from secrets/vars, pulls the
# requested image tag, pins the compose `.env`, brings the service up, and
# health-checks it.
#
# Nothing here is specific to any one deployment — every organisation-specific
# value arrives as a repo secret or variable. See plans/time-tracker.md.
#
# Deploy config (env vars; an optional ./deploy.env next to this script is
# sourced first for local/manual runs):
#   REGISTRY          Container registry            (default ghcr.io)
#   IMAGE_PREFIX      Image path under the registry (default cinderblock/time-tracker)
#   APP_TAG           Image tag to deploy           (REQUIRED — CI passes the commit sha)
#   APP_PORT          Host loopback port            (default 9020)
#   APP_DATA_DIR      Host SQLite data dir          (default /srv/time-tracker-data)
#   CONTAINER_NAME    Docker container name         (default time-tracker)
#   REGISTRY_USERNAME Registry login user           (optional; skips login if unset)
#   REGISTRY_TOKEN    Registry login token          (optional; skips login if unset)
#
# App config + secrets (materialized into the compose env_file). In CI these
# arrive as the ALL_SECRETS / ALL_VARS JSON blobs (toJSON(secrets|vars)):
#   PUBLIC_BASE_URL     public origin                (VAR,    REQUIRED)
#   SESSION_SECRET      signs session cookies        (SECRET, REQUIRED)
#   TZ                  wall-clock zone for workdays (VAR,    default UTC)
#   APP_NAME            branding                     (VAR,    default "Time Tracker")
#   APP_SHORT_NAME      branding                     (VAR,    default "Time")
#   APP_THEME_COLOR     branding                     (VAR,    default #1c7ed6)
#   APP_CURRENCY        ISO 4217 display currency    (VAR,    default USD)
#   ACCOUNTING_BACKEND  none|qb-bridge|qb-webconnector (VAR,  default none)
#   QB_BRIDGE_URL       bridge base URL, IPv4 literal (VAR,   optional)
#   QB_BRIDGE_API_KEY   bridge API key               (SECRET, optional)
#   QBWC_PASSWORD       Web Connector shared secret  (SECRET, optional)
#   VAPID_PUBLIC_KEY    web-push app server key      (VAR,    optional)
#   VAPID_PRIVATE_KEY   web-push signer              (SECRET, optional)
#   VAPID_SUBJECT       web-push contact URL         (VAR,    optional)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

# Local/manual override file (gitignored). CI sets everything via env.
if [ -f "${SCRIPT_DIR}/deploy.env" ]; then
	echo "Sourcing deploy.env"
	# shellcheck disable=SC1091
	set -a && . "${SCRIPT_DIR}/deploy.env" && set +a
fi

REGISTRY="${REGISTRY:-ghcr.io}"
IMAGE_PREFIX="${IMAGE_PREFIX:-cinderblock/time-tracker}"
APP_PORT="${APP_PORT:-9020}"
APP_DATA_DIR="${APP_DATA_DIR:-/srv/time-tracker-data}"
CONTAINER_NAME="${CONTAINER_NAME:-time-tracker}"
# Materialized below, next to this script (gitignored), consumed by compose's
# `env_file`. We never keep a hand-placed secrets file on the host.
APP_ENV_FILE="${SCRIPT_DIR}/app.env"

if [ -z "${APP_TAG:-}" ]; then
	echo "Error: APP_TAG must be set (the image tag to deploy, e.g. the commit sha)." >&2
	exit 1
fi

IMAGE="${REGISTRY}/${IMAGE_PREFIX}:${APP_TAG}"
echo "=== Deploying ${IMAGE} ==="

# jq is only needed to parse the CI JSON blobs.
if [ -n "${ALL_SECRETS:-}" ] || [ -n "${ALL_VARS:-}" ]; then
	if ! command -v jq > /dev/null 2>&1; then
		echo "Installing jq..."
		sudo apt-get update -qq
		sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq jq
	fi
fi

json_get() { # $1=json blob  $2=key  -> value (empty if blob empty or key absent)
	[ -n "${1:-}" ] || {
		printf ''
		return
	}
	printf '%s' "$1" | jq -r --arg k "$2" '.[$k] // empty'
}

# Secrets: prefer an already-exported value (manual run), else ALL_SECRETS (CI).
SESSION_SECRET="${SESSION_SECRET:-$(json_get "${ALL_SECRETS:-}" SESSION_SECRET)}"
QB_BRIDGE_API_KEY="${QB_BRIDGE_API_KEY:-$(json_get "${ALL_SECRETS:-}" QB_BRIDGE_API_KEY)}"
QBWC_PASSWORD="${QBWC_PASSWORD:-$(json_get "${ALL_SECRETS:-}" QBWC_PASSWORD)}"
VAPID_PRIVATE_KEY="${VAPID_PRIVATE_KEY:-$(json_get "${ALL_SECRETS:-}" VAPID_PRIVATE_KEY)}"

# Non-secret config: exported value -> repo Variable (ALL_VARS) -> default.
var_or() { # $1=name  $2=default
	local v="${!1:-}"
	[ -n "$v" ] || v="$(json_get "${ALL_VARS:-}" "$1")"
	printf '%s' "${v:-$2}"
}

PUBLIC_BASE_URL="$(var_or PUBLIC_BASE_URL '')"
TZ_VALUE="$(var_or TZ 'UTC')"
APP_NAME="$(var_or APP_NAME 'Time Tracker')"
APP_SHORT_NAME="$(var_or APP_SHORT_NAME 'Time')"
APP_THEME_COLOR="$(var_or APP_THEME_COLOR '#1c7ed6')"
APP_CURRENCY="$(var_or APP_CURRENCY 'USD')"
ACCOUNTING_BACKEND="$(var_or ACCOUNTING_BACKEND 'none')"
QB_BRIDGE_URL="$(var_or QB_BRIDGE_URL '')"
VAPID_PUBLIC_KEY="$(var_or VAPID_PUBLIC_KEY '')"
VAPID_SUBJECT="$(var_or VAPID_SUBJECT '')"

missing=""
[ -n "${PUBLIC_BASE_URL}" ] || missing="${missing} PUBLIC_BASE_URL(var)"
[ -n "${SESSION_SECRET}" ] || missing="${missing} SESSION_SECRET(secret)"
if [ -n "${missing}" ]; then
	echo "Error: missing required config:${missing}" >&2
	echo "Set them on ${IMAGE_PREFIX}, e.g.:" >&2
	echo "    gh variable set PUBLIC_BASE_URL --repo ${IMAGE_PREFIX}" >&2
	echo "    gh secret set SESSION_SECRET --repo ${IMAGE_PREFIX}" >&2
	exit 1
fi

# PUBLIC_BASE_URL is the WebAuthn Relying Party origin. A trailing slash or a
# path makes passkey registration fail in a way that looks like a browser bug,
# so reject it here rather than at 2am on someone's phone.
case "${PUBLIC_BASE_URL}" in
	https://*/ | http://*/)
		echo "Error: PUBLIC_BASE_URL must not end in a slash (got ${PUBLIC_BASE_URL})." >&2
		exit 1
		;;
	https://* | http://*) ;;
	*)
		echo "Error: PUBLIC_BASE_URL must start with http:// or https:// (got ${PUBLIC_BASE_URL})." >&2
		exit 1
		;;
esac

# Echo the resolved non-secret config. TZ in particular can be inherited from
# the runner's own environment when no repo variable sets it, and a silently
# wrong timezone books evening work onto the following day — so make every
# resolved value visible in the deploy log rather than discoverable at payroll.
cat << EOF

Resolved configuration:
  PUBLIC_BASE_URL    ${PUBLIC_BASE_URL}
  TZ                 ${TZ_VALUE}
  APP_NAME           ${APP_NAME}
  APP_CURRENCY       ${APP_CURRENCY}
  ACCOUNTING_BACKEND ${ACCOUNTING_BACKEND}
  QB_BRIDGE_URL      ${QB_BRIDGE_URL:-(unset)}
  web push           $([ -n "${VAPID_PRIVATE_KEY}" ] && echo enabled || echo disabled)

EOF

echo "Writing app env file ${APP_ENV_FILE}..."
(
	umask 077
	cat > "${APP_ENV_FILE}" << EOF
PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
SESSION_SECRET=${SESSION_SECRET}
TZ=${TZ_VALUE}
APP_NAME=${APP_NAME}
APP_SHORT_NAME=${APP_SHORT_NAME}
APP_THEME_COLOR=${APP_THEME_COLOR}
APP_CURRENCY=${APP_CURRENCY}
ACCOUNTING_BACKEND=${ACCOUNTING_BACKEND}
QB_BRIDGE_URL=${QB_BRIDGE_URL}
QB_BRIDGE_API_KEY=${QB_BRIDGE_API_KEY}
QBWC_PASSWORD=${QBWC_PASSWORD}
VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY}
VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY}
VAPID_SUBJECT=${VAPID_SUBJECT}
EOF
)

mkdir -p "${APP_DATA_DIR}"

# Pin the compose project to these exact values — compose auto-loads ./.env.
cat > "${SCRIPT_DIR}/.env" << EOF
REGISTRY=${REGISTRY}
IMAGE_PREFIX=${IMAGE_PREFIX}
APP_TAG=${APP_TAG}
APP_PORT=${APP_PORT}
APP_ENV_FILE=${APP_ENV_FILE}
APP_DATA_DIR=${APP_DATA_DIR}
CONTAINER_NAME=${CONTAINER_NAME}
EOF

if [ -n "${REGISTRY_TOKEN:-}" ] && [ -n "${REGISTRY_USERNAME:-}" ]; then
	echo "Logging into ${REGISTRY}..."
	echo "${REGISTRY_TOKEN}" | docker login "${REGISTRY}" -u "${REGISTRY_USERNAME}" --password-stdin
fi

echo "Pulling image..."
docker compose pull

echo "Bringing service up..."
docker compose up -d --remove-orphans

echo "Waiting for the app to answer on 127.0.0.1:${APP_PORT}..."
for i in $(seq 1 30); do
	if curl -fsS -o /dev/null "http://127.0.0.1:${APP_PORT}/"; then
		echo "App is up."
		break
	fi
	if [ "$i" -eq 30 ]; then
		echo "Error: app did not become healthy after 30s." >&2
		docker compose logs --tail 50 app
		exit 1
	fi
	sleep 1
done

echo ""
echo "=== Deploy complete: ${IMAGE} ==="
docker compose ps
