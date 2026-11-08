# Vector server

The Vector server is the API behind the [Vector UI](https://github.com/adhithyananilkumar/vector-balena-ui). The UI is a
static website; everything that needs a secret, a database connection or a long-lived connection lives here. The source
is in [`src/vector-server`](../src/vector-server).

```
Browser ── Vector UI (static, e.g. Vercel)
   │            │
   │            └── REST + WebSocket ──▶ Vector server ──▶ PostgREST (admin database)
   │                                          │       ├──▶ openBalena API (OData, device config)
   │                                          │       ├──▶ S3 / registry storage
   │                                          │       ├──▶ VPN tunnel (device SSH)
   │                                          │       └──▶ delta server (build records)
   └── OData ───────────────────────────────▶ openBalena API (fleets, devices, releases)
```

The browser still talks to the openBalena API directly for ordinary fleet, device and release data. The Vector server
handles what that API cannot or must not do from a browser.

## What it provides

| Area | Routes | What it does | Reference |
| ---- | ------ | ------------ | --------- |
| Admin database | `/admin-db/*` | Allowlisted PostgREST access plus actions (create user, API keys, change password, role-aware deletions). Enforces roles and organization scope. | [access-controls.md](access-controls.md), [direct-db-access.md](direct-db-access.md) |
| Host OS and Supervisor updates | `/balena-os/*`, `/device-update-options`, `/device-supervisor-target` | Syncs balenaOS and Supervisor releases from the public catalog and assigns update targets. | [os-and-supervisor-updates.md](os-and-supervisor-updates.md) |
| Image maker | `/image-maker/*` | Downloads balenaOS base images once, writes a fleet's `config.json` into a private copy and hands out a signed download link. | [Add device](https://github.com/adhithyananilkumar/vector-balena-ui/blob/main/src/vector/docs/content/add-device.md) |
| Remote access | `/remote/session`, `/remote/ws`, `/remote/sftp/*` | Browser terminals and streaming SFTP to devices through the openBalena VPN tunnel, with per-user ephemeral SSH keys. | [remote-access.md](remote-access.md) |
| Delta records | `/deltas/records` | Build times and sizes of delta updates, for the Delta builds page. | [delta-updates.md](delta-updates.md) |
| Registry cleanup | `/deleteRegistryImage`, `/deleteOrphanedRegistryImages` | Removes image blobs when images are deleted in the UI. | |
| Health | `/healthz` | Unauthenticated liveness check used by Docker. | |

Every route except `/healthz` and the read-only device-type metadata route (which the openBalena API fetches) requires
a valid openBalena bearer token.

## Running it

### In the Docker stack (recommended)

The `vector-server` service in the root [`docker-compose.yml`](../docker-compose.yml) builds the image and wires it to
the other services. Secrets (JWT secret, S3 keys) are read from the stack's shared secrets file, so nothing is copied by
hand.

```sh
docker compose up -d vector-server
curl http://127.0.0.1:3001/healthz        # {"ok":true}
```

Useful overrides (shell environment or the stack's `.env`):

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `VECTOR_SERVER_PORT` | `3001` | Host port, bound to `127.0.0.1` only. Put HTTPS in front of it for anything beyond localhost. |
| `VECTOR_ALLOWED_ORIGINS` | `http://localhost:3000` | Browser origins of the hosted UI (comma separated). |
| `VECTOR_PUBLIC_URL` | `http://localhost:3001` | Public address of this server. |
| `VECTOR_SSH_TRUST_ON_FIRST_USE` | `true` | Demo default. Set `false` and pin host keys in production. |

Base images, prepared images and learned SSH host keys are stored in the `vector-data` volume.

### On the host, for development

```sh
cd src/vector-server
cp /path/to/your/settings .env     # see vector-server-configuration.md
npm install
npm run dev                         # reloads on change, listens on :3001
```

When the openBalena stack uses a private CA, point Node at it so calls to `https://api.<domain>` verify:

```sh
NODE_EXTRA_CA_CERTS=.certs/ca.pem npm run dev
```

Run only one of the container and the host process on port 3001. For the container use `VECTOR_SERVER_PORT` to pick a
different host port.

### Hosting the UI somewhere else

1. Build the UI with `REACT_APP_VECTOR_SERVER_URL` set to this server's public HTTPS address.
2. Add the UI's origin to `VECTOR_ALLOWED_ORIGINS` and restart the server.
3. Make sure the openBalena API also allows the UI's origin (its own CORS setting).

The server answers CORS preflights for listed origins only, sets no cookies and never enables credentialed requests;
authentication is the bearer token in the `Authorization` header. Remote-access WebSockets use single-use tickets and
check the `Origin` header against the same list. See [vector-server-configuration.md](vector-server-configuration.md)
for every setting.

## Layout

```
src/vector-server/
├── src/
│   ├── index.ts            process entry: CORS, health, remote-access upgrade, routes
│   ├── routes/             one file per area (adminDatabase, deviceUpdates, balenaOs, imageMaker, deltas ...)
│   ├── middleware/         authorize (JWT), dosProtect (rate limits), cors
│   ├── remoteAccess/       terminal and SFTP gateway (ssh2, tunnel, tickets, host-key pinning)
│   ├── imageMaker/         base image store and configured image jobs
│   ├── util/s3/            S3 client and bucket names
│   └── shared/             code also used by the UI; see below
├── test/                   fixtures and the opt-in real-API integration test
├── Dockerfile, entrypoint.sh
└── package.json
```

### Shared code

`src/shared/` holds small modules the UI needs too: the API compatibility table (`versions/`), password policy and
hashing, permission-hint messages and remote target parsing. They are **copies** of the files of the same name in the
UI repository's `src/lib` and `src/versions`; there is no shared package. When you change one, change both. The
compatibility table is described in the UI's [API versions](https://github.com/adhithyananilkumar/vector-balena-ui/blob/main/docs/api-versions.md).

## Tests and builds

```sh
cd src/vector-server
npm test             # unit and route tests (about 185)
npm run typecheck
npm run build        # one bundle in dist/, built with ncc
docker build -t vector-server .
```

The CI workflow [`vector-server.yml`](../.github/workflows/vector-server.yml) runs the same steps on every change under
`src/vector-server`.

### Real-API integration test (opt-in)

The tests under `test/` that talk to a real open-balena-api need Docker with Linux containers and are skipped unless
`BALENA_OS_INTEGRATION=1`.

```sh
cd src/vector-server
BALENA_OS_INTEGRATION=1 npx tsx --test test/balenaOsSync.integration.test.ts
```

In PowerShell:

```powershell
cd src/vector-server
$env:BALENA_OS_INTEGRATION = '1'
npx tsx --test test\balenaOsSync.integration.test.ts
Remove-Item Env:\BALENA_OS_INTEGRATION
```

It starts open-balena-api v49.6.5, PostgreSQL, Redis and PostgREST with synthetic data, verifies the Host OS metadata
references, permissions, idempotent recovery, cache invalidation and device configuration generation, and removes its
containers afterwards.

## Rate limits

Authenticated requests that succeed do not use up a quota. Failed authentication attempts are counted per client IP
and, once a user is verified, per user. The protected API limiter allows 100 failures with a slowdown; the BalenaOS
status route allows 600. Limits are per server process. Invalid or expired tokens are rejected after being counted and
never claim an authenticated exemption.
