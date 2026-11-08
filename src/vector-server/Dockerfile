# Vector server: the API behind the Vector UI (admin database access, image maker, remote access,
# OS sync, delta records). Built to one bundle with ncc.
FROM node:24-alpine AS build
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /usr/src/app
# the ncc bundle is self-contained, so no node_modules are shipped
COPY --from=build /usr/src/app/dist ./dist
COPY entrypoint.sh ./entrypoint.sh
RUN mkdir -p /usr/src/app/data && chown -R node:node /usr/src/app/data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/healthz >/dev/null || exit 1
ENTRYPOINT ["/bin/sh", "/usr/src/app/entrypoint.sh"]
