# Notice

`src/`, `typings/`, `package*.json`, `tsconfig.json`, `daemon.json` and `start.sh` are vendored from
https://github.com/ob-community/open-balena-delta (last upstream commit 2024-04-26).

Local changes:
- Request headers (which carry device bearer tokens) are no longer written to the log.
- Built from source in `Dockerfile` instead of using the published image.
- `entrypoint.sh` is new: CA trust, builder token from the shared secrets volume, startup checks.

The upstream repository did not state a clear license for this code when it was vendored. Confirm
before distributing this stack outside your organisation.
