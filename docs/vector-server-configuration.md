# Vector server configuration

Every setting of the Vector server, read from the process environment (or `src/vector-server/.env` when run
directly). The UI has its own, smaller set; see the [UI configuration](https://github.com/adhithyananilkumar/vector-balena-ui/blob/main/docs/configuration.md). For what the
server is and how to run it, see [vector-server.md](vector-server.md).

## Configuration reference

These variables configure the Vector server:

- `PORT` The port the server listens on. Defaults to `3001`.

- `HOST` The interface it binds. Defaults to `0.0.0.0`.

- `OPEN_BALENA_POSTGREST_URL` The internal URL (accessible to the Vector server, not browsers) of the
  `open-balena-postgrest` instance, i.e. `http://postgrest.openbalena.local:8000`. It must point directly to a PostgREST
  endpoint that returns JSON, not to an older open-balena-ui deployment or its HTML fallback.

- `OPEN_BALENA_BOOTSTRAP_USER_ID` The trusted existing user ID allowed to create and receive the first `global-admin`
  role at server startup. This must be the positive numeric `user.id` (for example `2`), not a username or email
  address. Leave it unset to retain legacy access when `global-admin` does not exist, in which every authenticated user
  is effectively a super administrator; remove it after successful bootstrap.

- `OPEN_BALENA_ORGANIZATION_ADMIN_ASSIGNABLE_ROLES` Optional comma-separated exact role names that `organization-admin`
  users may view and assign to users inside their organization scope. Administrator roles are always excluded. Leave
  unset to prevent organization administrators from changing user role assignments.

- `OPEN_BALENA_OS_CATALOG_API_URL` Optional source API for Services > BalenaOS synchronization. It defaults to the
  public `https://api.balena-cloud.com` catalog.

- `OPEN_BALENA_OS_REGISTRY_HOST` Optional registry hostname used for synchronized Host OS image locations. Set it to
  `registry2.balena-cloud.com` for direct public pulls, or to a local pull-through proxy hostname for restricted-egress
  deployments. The server otherwise discovers it from an existing local image, then falls back from `api.<domain>` to
  `registry.<domain>`. Configure this explicitly when neither convention is valid.

- `CONTRACT_ALLOWLIST` Mirror the API's semicolon-separated contract allowlist. `hw.device-type/<slug>` entries filter
  catalog discovery and metadata synchronization; architecture entries alone do not restrict device types.

- `OPEN_BALENA_S3_URL` S3-compatible endpoint (SeaweedFS S3 gateway, MinIO, or AWS S3). The Vector server uses AWS SDK v3
  with forced path-style addressing; this is not the SeaweedFS filer endpoint. `OPEN_BALENA_S3_ACCESS_KEY` and
  `OPEN_BALENA_S3_SECRET_KEY` are server-only storage credentials, `OPEN_BALENA_S3_REGION` defaults to `us-east-1`, and
  `OPEN_BALENA_S3_REGISTRY_BUCKET` defaults to `registry-data`. Keep these backend-neutral variable names when changing
  storage providers.

- `OPEN_BALENA_OS_METADATA_BUCKET` Required private S3-compatible bucket for Host OS synchronization on API v46.1+.
  Provision it and grant the existing UI storage identity read/write access. Metadata is served by the UI, not by a
  public bucket policy.

- `OPEN_BALENA_OS_METADATA_URL` Optional stable UI base URL reachable from ob-api. Defaults to
  `VECTOR_PUBLIC_URL`. The read-only `/balena-os/device-types/.../device-type.json` route needs no login.

- `OPEN_BALENA_OS_METADATA_SOURCE_URL` Optional public metadata source, used only during manual sync. Defaults to
  `https://resin-production-img-cloudformation.s3.amazonaws.com/images`.

For local development, run the server with `npm run dev` and the UI with its own `npm run dev`; the UI dev server forwards these routes to this server.

Services > BalenaOS shows local Host OS coverage and Balena Cloud's public Host OS catalog. A global administrator can
start an additive, idempotent synchronization into the required `balena_os` system organization. The server reads the
public catalog, rewrites Cloud registry locations to the configured Host OS registry hostname, and creates or updates
the application/release/service/image graph through open-balena-api. A server-only direct-database exception links each
Host OS application to its updater because public OData does not expose that internal relation. It also materializes
Host OS image labels from the public release composition so Supervisors distinguish OS payloads from ordinary services.
On open-balena-api v43.4.0 and newer it also imports the public `balena_os/balenahup` updater graph and links Host OS
applications to it so Helios can plan the actual OS transition. It does not delete local records. On API v46.1+, sync
also stores allowlisted device-type JSON in private S3-compatible storage and writes local release assets pointing to
the UI's read-only metadata endpoint. It creates and authorizes the release/key records through OData, then persists
only their WebResource references through internal PostgREST because PineJS rejects ordinary JSON asset writes. It
verifies all references, triggers the API's host-application metadata-cache hook, and checks API metadata before
reporting completion. This lets ob-api generate device config without public S3 metadata reads. The asset URL contains
no storage credentials; no ob-api image patch or `WEBRESOURCES_S3_*` configuration is needed. An internal metadata URL
only needs to be reachable by ob-api: it is not sent to devices in normal balenaOS provisioning or target-state
responses. Provisioning images and device image pulls use their separate helper/registry routes. For chart-managed
installations, the infrastructure chart owns the automated, idempotent MinIO-to-SeaweedFS migration and private
bucket/credential setup. Operators do not run manual migration commands in this UI repository; follow the installation's
infrastructure chart deployment guide. Existing MinIO deployments remain supported. Progress is kept in server memory,
so the UI polls every five seconds and the Vector server must remain running until the job finishes. The configured registry
endpoint must either serve the public image directly or proxy missing paths to the source registry. Synchronization does
not copy registry blobs and does not automatically change any fleet or device target release. The `balena_os`
organization owns the imported catalog records only; Host OS releases are installation-wide and do not need to share an
organization with a target fleet. Synchronization is disabled until that system organization exists. Registry locations
are rewritten when records are synchronized; rerun the sync after changing `OPEN_BALENA_OS_REGISTRY_HOST` to update
existing imported image records.

See [OS_AND_SUPERVISOR_UPDATES.md](os-and-supervisor-updates.md) for the complete deployment, registry, organization,
security, and update-lifecycle configuration.

Host OS updates use the synchronized image location returned by open-balena-api's device-state endpoint. The helper's
`/download` route serves provisioning images, while its `/v6/supervisor_release` hostname rewrite applies only to
supervisor updates. Consequently, synchronized Host OS image locations do not require an open-balena-helper change. A
query-time Host OS rewrite would instead require proxying and transforming device-state responses, which the current
helper and deployment routing do not do.

Supervisor updates always assign a local release ID through `device.should_be_managed_by__release`;
`device.supervisor_version` is device-reported state and is never written by the UI. Compatible versions are obtained
from Balena Cloud's public release catalog by CPU architecture. When a selected release is not present locally, the UI
server synchronizes that release's application, service, image, and release graph through open-balena-api before
assigning it. Supervisor applications are owned by a `balena_os` system organization so their required
`balena_os/<architecture>-supervisor` slugs are preserved. Because open-balena-api does not expose organization
creation, this organization must be provisioned through the installation's administrative bootstrap before a Supervisor
release is assigned, and the administrative API identity must be a member. The synchronized image location uses the same
configured registry hostname as Host OS synchronization, so deployments whose helper implements `/v6/supervisor_release`
can retain their existing Supervisor image proxy. A public-catalog lookup or synchronization failure is reported to the
user; it is not treated as an empty catalog.

For direct public pulls, set `OPEN_BALENA_OS_REGISTRY_HOST=registry2.balena-cloud.com`. This intentionally preserves the
source image location instead of changing its hostname. Devices must be able to reach `registry2.balena-cloud.com` for
manifests, its token realm at `api.balena-cloud.com`, and `registry-data.balena-cloud.com` for redirected image blobs;
the public Host OS repositories issue anonymous pull tokens. No local registry or proxy participates in those Host OS
pulls, although openBalena still needs its normal private registry for user application images and locally produced
releases.

For restricted-egress or caching deployments, put an authentication-aware routing proxy in front of the private
registry. Stock openBalena does not configure this Cloud fallback. Mutating requests must go only to the private
registry; reads should prefer private content and fall back to `registry2.balena-cloud.com`. The proxy must keep device
credentials and the private registry authentication challenge away from Balena Cloud, perform the public registry token
exchange itself, and avoid exposing the Cloud hostname to devices. A plain Distribution `proxy.remoteurl` configuration
is not generally sufficient because the same endpoint must continue to accept private pushes. Set
`OPEN_BALENA_OS_REGISTRY_HOST` to the externally reachable proxy hostname, restart the Vector server, rerun synchronization,
and verify that an image absent from private storage can be pulled before assigning the release to a device.

The synchronization scope can be:

- **Latest + in use:** the latest usable release published for each device type, plus Host OS versions currently
  reported by devices of that type.
- **Newer than version + in use:** releases strictly newer than the entered semantic version, plus Host OS versions
  currently reported by devices of each device type.
- **Only versions in use:** only Host OS versions currently reported by devices, grouped by device type.
- **Single semantic version:** the requested version wherever that device type publishes it.
- **All catalog versions:** every usable release advertised by the version-appropriate public Host OS catalog.

When an entered or device-reported version omits build metadata such as `+rev1`, matching revisions are included. The
newer-than mode treats higher `+revN` builds of the threshold version as newer; a threshold without a revision includes
all revised builds of that version but not the unrevised version itself. The server fetches image and release-image
metadata only for selected releases, so selective modes reduce both database growth and catalog-transfer volume. When a
selected release has a `+revN` revision, its earlier non-invalidated revisions of the same semantic version are also
imported because open-balena-api assigns revisions sequentially. Invalidated releases are excluded from catalog counts
and every semantic-version decision. An invalidated release is imported only when a device of the matching type already
reports that exact version; it remains marked invalidated locally so it cannot be offered as an update target to other
devices.

On API v46.1+, each Host OS scope additionally maintains the latest usable release per allowed device type and its
prerequisite revisions for complete config-metadata coverage. The coverage pass attaches metadata to the newest eligible
local release, including an already-local release newer than those imported. Supervisor-only sync and older APIs are
unchanged. See [OS_AND_SUPERVISOR_UPDATES.md](os-and-supervisor-updates.md) for storage setup and cache refresh.

Built-in remote access uses these server-only variables:

- `OPEN_BALENA_TUNNEL_URL` Required HTTP(S) endpoint for the openBalena CONNECT tunnel. Use HTTPS for external
  endpoints, or `http://ob-vpn.openbalena.svc.cluster.local:3128` on a trusted private network. Plain HTTP exposes proxy
  authentication to that network; SSH payloads remain encrypted. The VPN port `443` can require PROXY protocol and is
  not interchangeable with the direct CONNECT port. The Vector server connects here; browsers do not.
- `OPEN_BALENA_SSH_TARGET_PORT` Device SSH port requested through the tunnel. Defaults to `22222`.
- `OPEN_BALENA_SSH_KEY_IDLE_TTL_MS` How long the per-user ephemeral SSH key remains registered after that user's last
  terminal or transfer closes. Defaults to `600000` (10 minutes).
- `OPEN_BALENA_SSH_HOST_KEYS` Comma-separated SHA-256 SSH host-key pins. Each entry is either a wildcard fingerprint
  (`SHA256:...`) or `device-uuid=SHA256:...` / `device-uuid.balena=SHA256:...`.
- `OPEN_BALENA_SSH_ALLOW_UNVERIFIED_HOST_KEYS` Compatibility escape hatch for devices without managed host-key pins.
  Defaults to `false`. An explicitly configured pin still rejects a mismatching key.
- `OPEN_BALENA_REMOTE_PUBLIC_ORIGIN` Optional explicit browser-facing HTTP(S) origin, for example
  `https://admin.example.test`. Set this when TLS terminates at a reverse proxy rather than the ob-ui socket.
  Without it, the effective origin comes from the direct socket's HTTP/HTTPS scheme and Host header. Forwarded headers
  are not trusted automatically.
- `OPEN_BALENA_REMOTE_ALLOWED_ORIGINS` Optional comma-separated additional browser origins allowed for terminal and
  transfer requests. Same-origin checks compare scheme, hostname, and effective port; a different scheme is not
  implicitly allowed. Additional origins must be configured explicitly.
- `OPEN_BALENA_REMOTE_TRUSTED_PROXIES` Optional comma-separated trusted proxy IPs/CIDRs, for example
  `10.0.0.10/32,10.0.0.11/32`. Empty trusts none. HTTP and WebSocket client addresses follow `X-Forwarded-For` only
  through explicitly trusted hops, stopping at the nearest untrusted address. Configure only actual ingress/proxy
  addresses; do not trust arbitrary forwarded headers or all client networks. Blanket IPv4/IPv6 `/0` policies are rejected.
  This address policy does not replace `OPEN_BALENA_REMOTE_PUBLIC_ORIGIN` for TLS-offload origin checks.
- `OPEN_BALENA_REMOTE_CONNECT_TIMEOUT_MS` Tunnel/SSH connection timeout and deadline for each key-store HTTP operation,
  including its response body. Defaults to `15000`.
- `OPEN_BALENA_REMOTE_TICKET_TTL_MS` Lifetime of single-use WebSocket tickets. Defaults to `30000`.
- `OPEN_BALENA_REMOTE_MAX_PENDING_TICKETS_PER_USER` Maximum unconsumed terminal tickets per user. Defaults to `8`.
- `OPEN_BALENA_REMOTE_MAX_PENDING_TICKETS` Maximum unconsumed terminal tickets per server process. Defaults to `1024`.
  Exceeding either pending-ticket limit returns HTTP `429` with `Retry-After`. Expired tickets are removed automatically,
  without requiring another request, and consumption releases their slots.
- `OPEN_BALENA_REMOTE_MAX_OPERATIONS_PER_USER` Maximum concurrent terminal/SFTP operations per user. Defaults to `8`.
- `OPEN_BALENA_REMOTE_MAX_WEBSOCKETS_PER_IP` Pre-authentication bound on simultaneous terminal WebSockets per resolved
  client IP. Defaults to `8`. Trusted-proxy configuration prevents all browsers behind an ingress from sharing its IP
  bucket; clients sharing a real NAT still share a bucket and may require a larger limit. Authenticated SSH/SFTP
  operation quotas remain separate, per user.
- `OPEN_BALENA_REMOTE_MAX_CHANNELS_PER_SOCKET` Maximum logical terminals per browser WebSocket. Defaults to `4`.
- `OPEN_BALENA_REMOTE_MAX_MESSAGE_BYTES` Maximum WebSocket message size. Defaults to `1048576`.
- `OPEN_BALENA_REMOTE_MAX_UPLOAD_BYTES` Maximum upload size. Defaults to `1073741824` (1 GiB).
- `OPEN_BALENA_REMOTE_MAX_PATH_BYTES` Maximum UTF-8 byte length of a device file path. Defaults to `4096`.

The built-in gateway also requires `OPEN_BALENA_POSTGREST_URL`, `OPEN_BALENA_JWT_SECRET`, and
`OPEN_BALENA_API_URL`, which are shared with the existing authenticated UI server routes. See
[REMOTE_ACCESS_ARCHITECTURE.md](remote-access.md) for protocol details, trust boundaries, host-key
management, deployment, and troubleshooting.
Missing JWT verification configuration prevents gateway initialization, so the UI reports built-in access as
unconfigured rather than advertising a gateway whose requests would all fail authentication.

### Browser access (CORS and WebSockets)

- `VECTOR_ALLOWED_ORIGINS` Comma-separated browser origins of the hosted Vector UI, for example
  `https://vector.example.com,http://localhost:3000`. Listed origins may call this server from the browser and open
  remote-access sockets. Entries must be bare `http(s)` origins; anything else stops the server at startup. When
  `OPEN_BALENA_REMOTE_ALLOWED_ORIGINS` is unset it defaults to this list. Requests carry bearer tokens, never cookies,
  so credentials are not enabled. Leave it empty only when the UI is served from the same origin through a proxy.
- `VECTOR_PUBLIC_URL` Public URL of this server, used as the default for `OPEN_BALENA_OS_METADATA_URL`.

### Image maker, deltas and the data directory

- `VECTOR_IMAGE_MAX_STREAMS` How many OS images may stream to browsers at once. Defaults to `2`.
- `VECTOR_IMAGE_TMP_DIR` Scratch folder for the boot partition (tens of megabytes) while an image streams; it is removed
  before the rest of the image is sent. Defaults to the system temp folder. OS images themselves are never stored.
- `VECTOR_OS_CATALOG_API_URL` Where balenaOS versions and downloads come from. Defaults to `https://api.balena-cloud.com`.
- `VECTOR_DELTA_URL` Address of the delta server for the Delta builds page. Defaults to `https://delta.<api host>`;
  the compose stack sets `http://delta:80`. See [delta-updates.md](delta-updates.md).
- `OPEN_BALENA_SSH_TRUST_ON_FIRST_USE` Learn a device's SSH host key the first time it is seen and pin it afterwards
  (stored in `data/ssh-known-hosts.json`). Defaults to on only when `NODE_ENV=development`.
- `OPEN_BALENA_SSH_KNOWN_HOSTS_FILE` Location of that file.

### Variables renamed from the old open-balena-ui

The server no longer uses the `REACT_APP_` prefix, which belongs to the browser build:

| Old name                              | Name now                    |
| ------------------------------------- | --------------------------- |
| `REACT_APP_OPEN_BALENA_API_URL`       | `OPEN_BALENA_API_URL`       |
| `REACT_APP_OPEN_BALENA_API_VERSION`   | `OPEN_BALENA_API_VERSION`   |
| `REACT_APP_OPEN_BALENA_ODATA_VERSION` | `OPEN_BALENA_ODATA_VERSION` |
| `REACT_APP_OPEN_BALENA_UI_URL`        | `VECTOR_PUBLIC_URL`         |
