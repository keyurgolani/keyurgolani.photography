# The curator

The curator is the private side of the site, where you review new photographs before they reach the draft (#14). It runs as its own service, `curator`, from the same image as `web`. Only `/curation/**` and `/api/curation/**` are curator paths. You sign in at `/curation/login`, and `/curation` leads to the inbox, `/curation/inbox`, where each item the watcher opened waits for you: approve a new photograph into the draft (**Approve into draft**), edit its suggestion (**Save edits**), leave it for later (**Decide later**, which keeps it a draft suggestion), dismiss it with a reason, retry processing, or reopen it. None of them publishes, and an item that changed since the page loaded is turned away with nothing written, so refresh and review it again. Photograph previews and the list's thumbnails come from `/api/curation/media/`, which serves a derivative set to the curator only and is never cached. A row's thumbnail is its set's smallest WebP, never the original; a row with no ready set shows a plain square.

After **Approve into draft** or **Decide later**, the inbox opens the next item that needs a decision, in list order, starting again from the top after the last one, and says what it just did. Its answer links back to the item you decided, where **Reopen** is. Once nothing needs a decision, it shows the empty state. On a phone it shows one thing at a time: the list, or the item you opened, with **Back to inbox** (or the browser's Back) returning to the list where you left it.

## Who can reach it

Whoever can open port 3001 on the host's loopback and knows the curator's passphrase. Nobody else.

- `curator` publishes only on the host's `127.0.0.1:3001`, never on another interface, and it sits on a network of its own, so neither `web` nor any other container can reach it.
- From another machine, the way in is an SSH local port forward. Your SSH key, checked by the host's `sshd`, decides who reaches the port at all.

  ```bash
  ssh -L 3001:127.0.0.1:3001 <host>
  ```

  Then open `http://127.0.0.1:3001/curation` or `http://localhost:3001/curation` on your machine.
- If 3001 is taken on your machine, forward another local port and tell the curator about it with `CURATOR_TUNNEL_PORT` (see below), say `ssh -L 4011:127.0.0.1:3001 <host>` with `CURATOR_TUNNEL_PORT=4011` in the `.env` next to `docker-compose.prod.yml`. The forward's far end stays `127.0.0.1:3001`.
- Anyone with a shell on the host can reach the port too. Keep the host's accounts to the people you'd hand the curator to.
- Then the curator asks for its passphrase, which you set when you deploy it (below). The login is defense in depth on top of the tunnel, not a reason to open the port wider: never publish it on another interface, put it behind a public reverse proxy, or share it through a tunnel service.

Every curator page, route handler and server action runs `requireCurator()` (`lib/curation/auth/index.ts`) first. It checks the flag, then the `Host`, then the `Origin` on anything that changes state, then a live session. Only the login page and its form skip the session.

## The login credential

The owner chose this on 2026-10-25: "Allow user to define a login credential at deployment time." The credential is two files you make on the host when you deploy, under `./secrets/` next to `docker-compose.prod.yml`:

| File | What it is |
|------|------------|
| `secrets/curator-passphrase.hash` | The scrypt hash of the passphrase (`N=32768, r=8, p=1`, a salt of its own), one line. Never the passphrase itself. |
| `secrets/curator-session.key` | 32 random bytes that sign the session cookie. |

Both belong to uid 1001, the user `curator` runs as, with mode `0400`, so only it can read them. The folder is `0700`, owned by uid 1001 too. They never go in git (`secrets/` is in `.gitignore`), the image (`.dockerignore`), Compose values or the environment: `curator` mounts `./secrets` read-only at `/run/secrets/curator`, and no other service mounts it. `ci/check-compose.sh` fails a Compose file that mounts it anywhere else or sets a secret in an environment.

### Making them

Run this once, from the folder that holds `docker-compose.prod.yml`, with `PHOTOGRAPHY_IMAGE_TAG` set to the release you run. The commands run in the release image as uid 1001, with no network, so the files come out owned by uid 1001 and `0400`:

```bash
sudo install -d -m 0700 -o 1001 -g 1001 secrets
docker run --rm -it --network none --user 1001:1001 -v "$PWD/secrets:/secrets" \
  ghcr.io/keyurgolani/keyurgolani.photography:"$PHOTOGRAPHY_IMAGE_TAG" \
  node dist/scripts/photos.mjs curation hash-passphrase --out /secrets/curator-passphrase.hash
docker run --rm --network none --user 1001:1001 -v "$PWD/secrets:/secrets" \
  ghcr.io/keyurgolani/keyurgolani.photography:"$PHOTOGRAPHY_IMAGE_TAG" \
  node dist/scripts/photos.mjs curation session-secret --out /secrets/curator-session.key
sudo ls -ln secrets
```

`hash-passphrase` asks for the passphrase twice with echo off, refuses an empty one, and writes only the hash. It prints no passphrase, hash or path. Choose a long passphrase you don't use anywhere else: the lockout below slows guessing, but it doesn't stop it. Piped instead of typed (`-i` in place of `-it`), it takes stdin with one trailing line break dropped, which keeps the passphrase in your shell's history if you type it into the command, so prefer the prompt. The last line should list both files as `-r--------` and owned by `1001 1001`.

### Rotating them

Make new ones the same way (each command replaces its file in one rename) and restart the curator:

```bash
docker compose -f docker-compose.prod.yml restart curator
```

A new passphrase hash counts from the next login. A new session secret, or any restart, ends every session. The files need no backup: if they're lost, make new ones.

### When one is missing

With `CURATION_ENABLED=true` and a secret file missing, unreadable, readable by anyone but its owner, or not one these commands wrote, the curator answers 503 on every path, the login page and `/api/health` included, and logs which setting is wrong, never a value. It never runs without them. Without the `secrets` folder at all, Docker won't start `curator`. With the flag off, the curator paths are 404 as always.

## Signing in

Open `http://127.0.0.1:3001/curation` (or `localhost`) through the tunnel. Without a session, it sends you to `/curation/login`. Enter the passphrase, and you're back at `/curation`.

- **Sessions.** A login starts a new session, a random 32-byte ID the curator keeps in its memory, and ends any session the browser had. It lasts 12 hours, then you sign in again. **Sign out** (a POST) ends it at once: the curator deletes it, so a copy of the cookie is worth nothing after. A restart of `curator` ends every session, which is fine: sign in again.
- **The cookie.** `curator_session` holds the session ID and an HMAC-SHA256 tag of it under the session secret. It's `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/` and `Max-Age=43200`. Browsers keep `Secure` cookies on `http://localhost` and `http://127.0.0.1`, which is what the tunnel serves (`e2e/curator-login.spec.ts` checks both). Cookies are kept by host name, not port, so other servers on your own machine's `localhost` get the cookie too; sign out when you're done.
- **The lockout.** Five failed logins within 15 minutes lock login for 15 minutes. It's one lock for the whole curator, not one per client: every request comes over loopback, so every client looks the same, and whatever else a client sends to tell itself apart is the client's to change. While it's on, the right passphrase is refused too, with the same answer as a wrong one, and the login page says the lock is on. Someone who can reach the port can keep you locked out; that is someone who already has the host or your tunnel. A restart of `curator` clears the lock.

## Turning it on and off

`curator` belongs to a Compose profile of its own, so `docker compose up -d` never starts it. Make [the login credential](#the-login-credential) first. Then start it by name when you need it, and stop it when you're done:

```bash
docker compose -f docker-compose.prod.yml up -d curator
docker compose -f docker-compose.prod.yml stop curator
```

Its restart policy is `no`, so a reboot or a Docker restart leaves it off. It reads the library (`:ro`), writes the data root, and runs as uid 1001, the watcher's, so the data root setup in [data-root.md](data-root.md) covers it too.

## What keeps it private

Each of these holds on its own. `proxy.ts` checks the first five on every request, and `requireCurator()` checks them again (`lib/curation/auth/policy.ts`).

- **The flag.** `CURATION_ENABLED` turns the curator on, and only the exact value `true` does. It's read on every request, never at build time, so the one image serves both. While it's off, every curator path answers 404. Only `curator` sets it; `web` never does, and CI fails a Compose file that sets it anywhere else.
- **The bind.** With the flag on, a server told to listen beyond loopback stops at startup with a message, and refuses every curator request until it exits. See the rule below.
- **The `Host` allowlist.** With the flag on, every request `proxy.ts` sees on the curator process, its public paths included, needs `Host: 127.0.0.1:3001` or `localhost:3001`, or the same names on `CURATOR_TUNNEL_PORT`. Any other answers 421. That turns away a page that points its own domain name at `127.0.0.1` (DNS rebinding). The service's healthcheck sends `Host: localhost:3001` for the same reason. Next's build files under `/_next/static` and `/_next/image` don't pass through `proxy.ts`, so they answer any `Host`. They're the same bytes `web` serves to anyone.
- **The `Origin` check.** Anything that can change state (every method but GET and HEAD, and every server action) also needs an `Origin` naming the same host and port over `http`. Anything else answers 403. That turns away a form or script on another site posting to the curator through your open tunnel. Login and logout are POSTs, so they need it too.
- **The session.** Every curator path but the login page and its form needs a live session. Without one, a page and its RSC fetch go to `/curation/login` (a 307), and a route handler or a server action answers 401.
- **The secret files.** With either one missing or unusable, every path answers 503.
- **The headers.** Every curator response sends `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`, and `Content-Security-Policy: frame-ancestors 'none'`, and every curator page renders per request.
- **Read-only everywhere else.** Outside the curator paths the site takes only GET, HEAD and OPTIONS, so a server action posted to `/` answers 404. `web` mounts the library and the data root read-only, and `/media` serves only what the active catalog revision holds.

### The bind rule

With `CURATION_ENABLED=true`, the server checks where it listens, twice.

1. The address it was told: `--hostname` (or `-H`) when `next start` runs it, and `HOSTNAME` otherwise, which the standalone `server.js` reads. It must be `127.0.0.1`, `::1` or `localhost`. An unset one counts as every interface, since that's what both servers do without it. `npm start` already passes `--hostname 127.0.0.1`.
2. The socket it actually listens on, once it does. Every one must be on loopback, whatever the settings said. Under `next dev`, whose server runs in a child process that gets `--hostname` over IPC, the socket is the only check, and a dev server whose socket can't be read stops. `npm run dev` already passes `--hostname 127.0.0.1`, so this just works:

```bash
CURATION_ENABLED=true \
  CURATOR_PASSPHRASE_HASH_FILE=secrets/curator-passphrase.hash \
  CURATOR_SESSION_SECRET_FILE=secrets/curator-session.key \
  npm run dev
```

For that, make test files with `npx tsx scripts/photos.ts curation hash-passphrase --out secrets/curator-passphrase.hash` and `npx tsx scripts/photos.ts curation session-secret --out secrets/curator-session.key`, with a passphrase you use nowhere else.

The one exception is the `curator` service. Docker's port forward reaches a container on its own network interface, so inside the container the server has to listen on every interface, and the publish to the host's `127.0.0.1` is the boundary. The service sets `HOSTNAME=0.0.0.0` with `CURATION_BIND_SCOPE=container`, which accepts `0.0.0.0` or `::` and nothing else, only where Docker's or Podman's container marker file exists, and only while the process sees one network interface beyond loopback. Outside a container, that setting stops the server. CI checks that `curator` is the only service with it, that its one published port is `127.0.0.1:3001`, and that it shares no network with another service.

The exception assumes the container has a network of its own. Never run the curator with the host's network (`network_mode: host`, `docker run --network host`, Kubernetes `hostNetwork`, or a toolbox or distrobox container): there `0.0.0.0` is every interface of the host. CI rejects `network_mode` on `curator`. The one-interface check stops it on a host with more than one active interface, such as the production host while `web` runs. It can't catch host networking on a host with one active interface, such as one network card and an idle Docker bridge, since an idle bridge doesn't count. Neither check covers a container started outside this Compose file.

## Settings

| Variable | Set on | What it does |
|----------|--------|--------------|
| `CURATION_ENABLED` | `curator` only | `true` turns the curator on. Anything else, or unset, keeps every curator path a 404. |
| `CURATOR_TUNNEL_PORT` | `.env`, read by `curator` only, optional | One more local port the `Host` allowlist answers to, for a tunnel that doesn't use 3001 on your machine. A value that isn't a port from 1 to 65535 stops the server. |
| `CURATION_BIND_SCOPE` | `curator` only | `container` lets the curator listen on every interface inside its container. Anything but `container` or unset stops the server. |
| `CURATOR_PASSPHRASE_HASH_FILE` | never in Compose | Where the passphrase hash is. Defaults to `/run/secrets/curator/curator-passphrase.hash`, where `curator` mounts it. For a curator run outside Compose, such as `next dev`. |
| `CURATOR_SESSION_SECRET_FILE` | never in Compose | Where the session secret is. Defaults to `/run/secrets/curator/curator-session.key`. |
