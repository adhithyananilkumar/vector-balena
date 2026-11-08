#!/bin/sh
set -eu

TLD="${DNS_TLD:?DNS_TLD is required}"
SECRETS="/balena/${TLD}.env"

# Wait for the stack to publish its secrets and CA bundle.
i=0
while [ ! -f "${SECRETS}" ] || [ ! -f /certs/root-ca.pem ] || [ ! -f /certs/server-ca.pem ]; do
  i=$((i + 1))
  [ "${i}" -gt 120 ] && { echo "[delta] secrets or CA not available" >&2; exit 1; }
  sleep 2
done

TOKEN_AUTH_BUILDER_TOKEN="$(grep '^TOKEN_AUTH_BUILDER_TOKEN=' "${SECRETS}" | cut -d= -f2-)"
export TOKEN_AUTH_BUILDER_TOKEN
# Key the Vector server uses to read build records (derived, so no new secret to manage).
JWT_SECRET="$(grep '^JSON_WEB_TOKEN_SECRET=' "${SECRETS}" | cut -d= -f2-)"
RECORDS_KEY="$(printf 'delta-records' | openssl dgst -sha256 -hmac "${JWT_SECRET}" | awk '{print $NF}')"
export RECORDS_KEY
unset JWT_SECRET
export BALENA_TLD="${TLD}"
export REGISTRY_HOST="registry2.${TLD}"
export DOCKER_HOST="unix:///var/run/docker.sock"
export DOCKER_BUILDKIT=0

# Trust the private CA for the docker CLI and the balena-engine daemon.
cp /certs/root-ca.pem /usr/local/share/ca-certificates/protofleet-root-ca.crt
cp /certs/server-ca.pem /usr/local/share/ca-certificates/protofleet-server-ca.crt
update-ca-certificates >/dev/null 2>&1 || true
mkdir -p "/etc/docker/certs.d/${REGISTRY_HOST}"
cat /certs/server-ca.pem /certs/root-ca.pem > "/etc/docker/certs.d/${REGISTRY_HOST}/ca.crt"
export NODE_EXTRA_CA_CERTS=/certs/ca-bundle.pem

if [ -f "/certs/private/api.${TLD}.pem" ]; then
  echo "[delta] device token verification enabled"
else
  echo "[delta] WARNING: api public certificate missing, requests are NOT authenticated" >&2
fi

cd /usr/src/app
exec sh /usr/src/app/start.sh
