#!/bin/sh
# Starts the Vector server inside the Docker stack. Secrets come from the stack's shared secrets file, so
# nothing has to be copied by hand; anything already set in the environment wins.
set -eu

TLD="${DNS_TLD:?DNS_TLD is required}"
SECRETS="/balena/${TLD}.env"

i=0
while [ ! -s "${SECRETS}" ]; do
  i=$((i + 1))
  [ "${i}" -gt 120 ] && { echo "[vector-server] ${SECRETS} not available" >&2; exit 1; }
  sleep 2
done

secret() { grep "^$1=" "${SECRETS}" | cut -d= -f2-; }
: "${OPEN_BALENA_JWT_SECRET:=$(secret JSON_WEB_TOKEN_SECRET)}"
: "${OPEN_BALENA_S3_ACCESS_KEY:=$(secret REGISTRY2_S3_KEY)}"
: "${OPEN_BALENA_S3_SECRET_KEY:=$(secret REGISTRY2_S3_SECRET)}"
export OPEN_BALENA_JWT_SECRET OPEN_BALENA_S3_ACCESS_KEY OPEN_BALENA_S3_SECRET_KEY

# trust the stack's private CA for calls to api.<tld> and s3.<tld>
[ -f /certs/ca-bundle.pem ] && export NODE_EXTRA_CA_CERTS=/certs/ca-bundle.pem

exec node /usr/src/app/dist/index.js
