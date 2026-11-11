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
| Image maker | `/image-maker/*` | Streams a balenaOS image from balena's download service to the browser with a fleet's `config.json` written into its boot partition, behind a signed, short-lived link. Nothing is stored on the server. | [Add device](https://github.com/adhithyananilkumar/vector-balena-ui/blob/main/src/vector/docs/content/add-device.md) |
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
| `VECTOR_SERVER_PORT` | `3001` | Host port, bound to `127.0.0.1` only. For anything beyond localhost use the HTTPS address below instead of opening this port. |
| `VECTOR_ALLOWED_ORIGINS` | `http://localhost:3000` | Browser origins of the hosted UI (comma separated), for example `https://vector.mydomain.com`. |
| `VECTOR_PUBLIC_URL` | `http://localhost:3001` | Public address of this server, for example `https://vector.<DNS_TLD>`. |
| `VECTOR_SSH_TRUST_ON_FIRST_USE` | `true` | Demo default. Set `false` and pin host keys in production. |

Learned SSH host keys are stored in the `vector-data` volume. OS images are not stored on the server at all.

### OS image downloads: integrity and audit

The Add device page streams a balenaOS image through the server: it is unzipped as it arrives, `config.json` is written into the boot partition, and the result goes to the browser. Only that boot partition (tens of megabytes) touches the server's disk, in a temporary file that is removed before the rest is sent.

- The data is checked against the CRC-32 and size recorded in balena's zip. The last megabyte is held back until the check passes, so a damaged or truncated image fails instead of looking complete.
- A download that receives nothing for 60 seconds, or whose balena connection is lost, fails with an error.
- A prepared image can be started 5 times and is discarded after 30 minutes; at most `VECTOR_IMAGE_MAX_STREAMS` images stream at once.
- Every prepare and download writes one JSON line to the server log (`docker compose logs vector-server`) with `"audit":"os-image"`: who prepared it, the device type, version, whether a device was registered, the sender address, the bytes sent, the time taken, whether the checksum matched (`verified`) and the error if it failed:

```json
{"audit":"os-image","at":"2026-11-11T11:22:23.224Z","ticket":"3d7a…","deviceType":"raspberrypi4-64","version":"9.0.3+rev2","event":"download-finished","bytes":952107008,"verified":true,"ms":12213}
```

Events are `image-prepared`, `download-started`, `download-finished` and `download-failed`.

The same service supports the local base-image flow used by the Add device wizard:

- `POST /image-maker/devices` registers a named device (it shows as offline, "Awaiting first boot") before any download.
- `POST /image-maker/os-downloads` prepares the unmodified balenaOS download for a device type and version. The browser saves it once in the user's own folder and reuses it. `POST /image-maker/boot-patch` returns only the changed boot-partition blocks plus the SHA-256 of the original head, so the browser builds a flash-ready image from its local base without downloading the OS again.
- Download links accept `?from=N` to resume after a dropped connection. A resume inside the boot partition is refused (HTTP 409) and the client restarts that file. Responses are gzip-compressed when the client accepts it.
- Audit events also include `base-image-prepared`, `boot-patch` and `device-added`.

### Public HTTPS address

The stack's `haproxy` already terminates TLS for every openBalena host, using the wildcard certificate for
`*.<DNS_TLD>`. It also sends `vector.<DNS_TLD>` to this server (`src/haproxy/haproxy.cfg`, backend `vector-backend`), so
once the DNS wildcard exists and the certificate is issued the server is reachable at `https://vector.<DNS_TLD>` with
no extra proxy and no extra published port. Check it:

```sh
curl https://vector.<DNS_TLD>/healthz     # {"ok":true}
```

Use that address for `REACT_APP_VECTOR_SERVER_URL` in the UI and for `VECTOR_PUBLIC_URL`. A trusted certificate is
required because a page served over HTTPS (for example on Vercel) cannot call a server whose certificate the browser
rejects. The stack issues a publicly trusted wildcard certificate when you provide a DNS provider token, see
[getting-started.md](getting-started.md#ssl-configuration).

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
│   ├── imageMaker/         streams configured OS images (unzip on the fly, patch the boot partition) and download tickets
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
