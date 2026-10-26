# The curator

The curator is the private side of the site, where you review new photographs before they reach the draft (#14). It runs as its own service, `curator`, from the same image as `web`. Only `/curation/**` and `/api/curation/**` are curator paths. Today there's only a placeholder page at `/curation`; the inbox comes with #14's 14-3.

## Who can reach it

Whoever can open port 3001 on the host's loopback. Nobody else.

- `curator` publishes only on the host's `127.0.0.1:3001`, never on another interface, and it sits on a network of its own, so neither `web` nor any other container can reach it.
- From another machine, the way in is an SSH local port forward. **The SSH tunnel is the authentication**: your SSH key, checked by the host's `sshd`, decides who gets in.

  ```bash
  ssh -L 3001:127.0.0.1:3001 <host>
  ```

  Then open `http://127.0.0.1:3001/curation` or `http://localhost:3001/curation` on your machine.
- If 3001 is taken on your machine, forward another local port and tell the curator about it with `CURATOR_TUNNEL_PORT` (see below), say `ssh -L 4011:127.0.0.1:3001 <host>` with `CURATOR_TUNNEL_PORT=4011` in the `.env` next to `docker-compose.prod.yml`. The forward's far end stays `127.0.0.1:3001`.
- Anyone with a shell on the host can reach the port too. Keep the host's accounts to the people you'd hand the curator to.
- Never publish the port wider, put it behind a public reverse proxy, or share it through a tunnel service. The curator has no login of its own yet, so any of those hands it to whoever finds the address.

There's no passphrase or session in the app. The approved design for #14 has one, and whether to add it is the owner's call. If it's added, it goes into `requireCurator()` in `lib/curation/auth/index.ts`, the one check every curator page, route handler and server action runs first.

## Turning it on and off

`curator` belongs to a Compose profile of its own, so `docker compose up -d` never starts it. Start it by name when you need it, and stop it when you're done:

```bash
docker compose -f docker-compose.prod.yml up -d curator
docker compose -f docker-compose.prod.yml stop curator
```

Its restart policy is `no`, so a reboot or a Docker restart leaves it off. It reads the library (`:ro`), writes the data root, and runs as uid 1001, the watcher's, so the data root setup in [data-root.md](data-root.md) covers it too.

## What keeps it private

Each of these holds on its own. `proxy.ts` checks the first four on every request, and `requireCurator()` checks them again (`lib/curation/auth/policy.ts`).

- **The flag.** `CURATION_ENABLED` turns the curator on, and only the exact value `true` does. It's read on every request, never at build time, so the one image serves both. While it's off, every curator path answers 404. Only `curator` sets it; `web` never does, and CI fails a Compose file that sets it anywhere else.
- **The bind.** With the flag on, a server told to listen beyond loopback stops at startup with a message, and refuses every curator request until it exits. See the rule below.
- **The `Host` allowlist.** With the flag on, every request `proxy.ts` sees on the curator process, its public paths included, needs `Host: 127.0.0.1:3001` or `localhost:3001`, or the same names on `CURATOR_TUNNEL_PORT`. Any other answers 421. That turns away a page that points its own domain name at `127.0.0.1` (DNS rebinding). The service's healthcheck sends `Host: localhost:3001` for the same reason. Next's build files under `/_next/static` and `/_next/image` don't pass through `proxy.ts`, so they answer any `Host`. They're the same bytes `web` serves to anyone.
- **The `Origin` check.** Anything that can change state (every method but GET and HEAD, and every server action) also needs an `Origin` naming the same host and port over `http`. Anything else answers 403. That turns away a form or script on another site posting to the curator through your open tunnel.
- **The headers.** Every curator response sends `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`, and `Content-Security-Policy: frame-ancestors 'none'`, and every curator page renders per request.
- **Read-only everywhere else.** Outside the curator paths the site takes only GET, HEAD and OPTIONS, so a server action posted to `/` answers 404. `web` mounts the library and the data root read-only, and `/media` serves only what the active catalog revision holds.

### The bind rule

With `CURATION_ENABLED=true`, the server checks where it listens, twice.

1. The address it was told: `--hostname` (or `-H`) when `next start` runs it, and `HOSTNAME` otherwise, which the standalone `server.js` reads. It must be `127.0.0.1`, `::1` or `localhost`. An unset one counts as every interface, since that's what both servers do without it. `npm start` already passes `--hostname 127.0.0.1`.
2. The socket it actually listens on, once it does. Every one must be on loopback, whatever the settings said. Under `next dev`, whose server runs in a child process that gets `--hostname` over IPC, the socket is the only check, and a dev server whose socket can't be read stops. `npm run dev` already passes `--hostname 127.0.0.1`, so this just works:

```bash
CURATION_ENABLED=true npm run dev
```

The one exception is the `curator` service. Docker's port forward reaches a container on its own network interface, so inside the container the server has to listen on every interface, and the publish to the host's `127.0.0.1` is the boundary. The service sets `HOSTNAME=0.0.0.0` with `CURATION_BIND_SCOPE=container`, which accepts `0.0.0.0` or `::` and nothing else, only where Docker's or Podman's container marker file exists, and only while the process sees one network interface beyond loopback. Outside a container, that setting stops the server. CI checks that `curator` is the only service with it, that its one published port is `127.0.0.1:3001`, and that it shares no network with another service.

The exception assumes the container has a network of its own. Never run the curator with the host's network (`network_mode: host`, `docker run --network host`, Kubernetes `hostNetwork`, or a toolbox or distrobox container): there `0.0.0.0` is every interface of the host. CI rejects `network_mode` on `curator`. The one-interface check stops it on a host with more than one active interface, such as the production host while `web` runs. It can't catch host networking on a host with one active interface, such as one network card and an idle Docker bridge, since an idle bridge doesn't count. Neither check covers a container started outside this Compose file.

## Settings

| Variable | Set on | What it does |
|----------|--------|--------------|
| `CURATION_ENABLED` | `curator` only | `true` turns the curator on. Anything else, or unset, keeps every curator path a 404. |
| `CURATOR_TUNNEL_PORT` | `.env`, read by `curator` only, optional | One more local port the `Host` allowlist answers to, for a tunnel that doesn't use 3001 on your machine. A value that isn't a port from 1 to 65535 stops the server. |
| `CURATION_BIND_SCOPE` | `curator` only | `container` lets the curator listen on every interface inside its container. Anything but `container` or unset stops the server. |
