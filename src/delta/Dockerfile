# Community delta update server (https://github.com/ob-community/open-balena-delta).
# Thin wrapper: trusts the stack's private CA, loads the builder token from the shared
# secrets volume, then starts the upstream balena-engine daemon and delta API.
FROM obcommunity/open-balena-delta:latest

# Upstream logs every request header, which includes the device's bearer token. Log only the query.
RUN sed -i 's/JSON.stringify({ query: query, headers: headers })/JSON.stringify({ query: query })/' /usr/src/app/dist/index.js \
    && grep -q 'JSON.stringify({ query: query })' /usr/src/app/dist/index.js

COPY entrypoint.sh /usr/src/app/entrypoint.sh
RUN chmod +x /usr/src/app/entrypoint.sh

ENTRYPOINT ["/bin/sh", "/usr/src/app/entrypoint.sh"]
