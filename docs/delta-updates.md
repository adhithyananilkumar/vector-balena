# Delta updates (community server)

Optional. Adds the community [open-balena-delta](https://github.com/ob-community/open-balena-delta)
server so devices download only the binary difference between the image they run and the new one.
It is not part of balena's openBalena and is not officially supported.

## What is added
- `delta` service (`src/delta`): vendored source of the community delta server, built in-repo (see `src/delta/NOTICE.md`). Runs its own balena-engine
  daemon, so it is `privileged`. Trusts the stack CA, reads the builder token from `/balena`, and
  verifies device JWTs with the API public certificate. The wrapper also stops the upstream server
  from logging bearer tokens.
- haproxy route `delta.<DNS_TLD>` -> `delta:80` (HTTPS frontend).
- Volumes `delta-engine` (scratch images, safe to prune) and `delta-rsync` (v2 deltas only).
- The API already advertises `DELTA_HOST` and devices already get `deltaEndpoint` in config.json.

## Enable per fleet
```bash
balena env set BALENA_SUPERVISOR_DELTA 1 --fleet <fleet>
balena env set BALENA_SUPERVISOR_DELTA_VERSION 3 --fleet <fleet>
```

## How it behaves
- The first request for a pair of images returns 504 while the server pulls both, builds the delta
  and pushes it to the registry; the supervisor keeps polling. Later requests are instant.
- A delta needs a source image of the same service on the device. First install of a service is a
  normal full pull.
- Pin base images by digest. If a base tag moves, deltas shrink little (upstream limitation).
- Keep ~2x the app size free on devices.

## Build records
The server keeps a record of every delta it builds (`delta-data` volume, `/data/records.json`): the
two releases, status, pull/diff/push times, compressed sizes and the devices that asked. The Vector UI
shows them under Provision > Delta builds. The [Vector server](vector-server.md) reads them from `VECTOR_DELTA_URL`
(`http://delta:80` inside the stack, or `http://127.0.0.1:3003` from the host) with a key derived from the stack's JSON web
token secret; devices cannot read them.
