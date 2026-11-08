# Vector server

API for the [Vector UI](https://github.com/adhithyananilkumar/vector-balena-ui): admin database access with role and
organization checks, balenaOS image maker, built-in browser terminals and file transfer, Host OS and Supervisor updates,
and delta build records. It runs next to the openBalena stack defined in the parent repository.

```sh
npm install
cp .env.template .env      # then fill it in
npm run dev                # http://localhost:3001, reloads on change
npm test                   # unit and route tests
npm run build              # single bundle in dist/
```

In the Docker stack it is the `vector-server` service: `docker compose up -d vector-server` from the repository root.

Documentation:

- [Vector server overview, running and hosting](../../docs/vector-server.md)
- [Configuration reference](../../docs/vector-server-configuration.md)
- [Access controls](../../docs/access-controls.md), [direct database access](../../docs/direct-db-access.md),
  [remote access](../../docs/remote-access.md), [Host OS and Supervisor updates](../../docs/os-and-supervisor-updates.md),
  [delta updates](../../docs/delta-updates.md)
