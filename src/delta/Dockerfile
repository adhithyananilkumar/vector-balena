# Delta update server, vendored from https://github.com/ob-community/open-balena-delta
# (see NOTICE.md). Built from source here; no external delta image is pulled.
FROM node:20-alpine3.18 AS build
WORKDIR /usr/src/app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-fund --no-audit && npm install --no-save --no-fund --no-audit typescript@5
COPY typings ./typings
COPY src ./src
RUN npx tsc --skipLibCheck && npm prune --omit=dev

FROM alpine:3.18
RUN apk add --no-cache \
    btrfs-progs e2fsprogs e2fsprogs-extra ip6tables iptables openssl \
    shadow-uidmap xfsprogs xz pigz zfs nodejs rsync ca-certificates

ENV DOCKER_CLI_VERSION="24.0.7"
RUN wget -O /tmp/docker-cli.tar.gz "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_CLI_VERSION}.tgz" \
    && tar -xzf /tmp/docker-cli.tar.gz -C /usr/local/bin --strip-components 1 docker/docker \
    && rm /tmp/docker-cli.tar.gz

ENV BALENA_ENGINE_VERSION="20.10.40"
RUN wget -O /tmp/balena-engine.tar.gz "https://github.com/balena-os/balena-engine/releases/download/v${BALENA_ENGINE_VERSION}/balena-engine-v${BALENA_ENGINE_VERSION}-amd64.tar.gz" \
    && tar -xzf /tmp/balena-engine.tar.gz -C /usr/local/bin \
    && rm /tmp/balena-engine.tar.gz \
    && addgroup -S balena-engine

VOLUME /var/lib/balena-engine
VOLUME /delta-rsync

COPY daemon.json /etc/balena-engine/daemon.json
WORKDIR /usr/src/app
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/dist ./dist
COPY package.json start.sh entrypoint.sh ./

ENTRYPOINT ["/bin/sh", "/usr/src/app/entrypoint.sh"]
