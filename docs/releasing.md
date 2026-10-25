# Releasing and deploying

Production runs one release tag for both containers. `main` tags an image `sha-<commit>` only after CI passes and that exact image passes the smoke test, and a release copies that digest. Releases never rebuild.

## What CI checks

Every pull request runs `.github/workflows/ci.yml`, whether it targets `main` or `next`:

| Job | What it does |
|---|---|
| `Lint, unit tests, build` | Checks that `.nvmrc` holds a bare Node major and the `Dockerfile` base image matches it, then runs `npm ci`, `npm run lint`, `npm test -- --run`, `npm run test:prod`, `ci/check-standalone.sh`, `npm run check:prerender`, and `npm run smoke:media`. `npm run test:prod` runs `npm run build`, serves a copy of `.next/standalone` on a temp data root, publishes twice and rolls back once, and checks that `/api/ready`, `/api/photos`, and `/media` follow each activation without a restart, and that the `/api/photos` ETag gets 304 only while the same revision and build are served, through a restart, and not after a new build ID. It also checks that no public JSON response or page names a legacy derivative or an original source path, that `/media` sets are `immutable` and legacy derivatives aren't, and that `/api/image` is 404. A second server then keeps serving the revision it loaded, as `degraded` and with the same ETag, once its active pointer is damaged and then removed. Plain `npm test` skips it unless `RUN_PROD_TESTS=1`, and the checks after it run on its build. `ci/check-standalone.sh` fails if the build copied project sources, the default data root, or the library into `.next/standalone`. `npm run check:prerender` fails if the build prerendered a route that reads the data root per request, `/api/photos`, `/api/ready`, or another path `ci/check-prerender.mjs` lists. `npm run smoke:media` publishes a small test catalog into a temp data root with `ci/publish-fixture.ts`, and checks that the build's `/media` route serves a set the active revision holds, 404s one whose files exist but which no revision holds, and that `/api/ready` names the revision. |
| `Browser tests` | Runs `npm run test:e2e`, which builds and serves the site against an empty temp photo library and runs `e2e/` in Chromium on a desktop and a Pixel 7 project, and `e2e/home-immersive.spec.ts` in WebKit on an iPhone 13 project, `mobile-webkit`. A failed run uploads `playwright-report/` and `test-results/`. |
| `Image smoke test` | Runs `ci/check-compose.sh`, builds the image, checks that it runs the Node major in `.nvmrc`, and runs `ci/smoke-image.sh` against it. Then it runs `ci/smoke-watcher-once.sh`, which checks that the image ships the bundled scripts and no dev dependencies or tsx, has the image's node generate a fixture library from the checkout's `test/fixtures`, runs the image's watcher with `--once` on it, checks that it deletes nothing after a photo is removed and exits 1 on a missing library, and checks the web server's image routes. Last, it runs `npm ci` and `ci/smoke-catalog.sh`, which checks the catalog routes in the image on a migrated fixture library and on a published test catalog. |
| `Production audit` | Runs `ci/audit-gate.mjs`, which runs `npm audit --omit=dev` and fails on a high or critical advisory that `.github/audit-allowlist.json` doesn't list. It reads only the lockfile, so it skips `npm ci`. |
| `CI result` | Fails unless all four jobs above succeeded. |

`CI result` is the only required check. A new push to a PR cancels its running CI.

`Production audit` can also turn CI red with no code change. That happens when the npm advisory service is unreachable, when a new high or critical advisory lands on a production dependency, or when an allowlist entry expires. Each of these also fails the `ci` job of a `main` publish, so nothing publishes and no release can be cut until it's fixed. [When the audit blocks `main`](#when-the-audit-blocks-main) covers the recovery.

`ci/check-compose.sh` checks that every image line in `docker-compose.prod.yml` is exactly `ghcr.io/keyurgolani/keyurgolani.photography:${PHOTOGRAPHY_IMAGE_TAG:?...}`, that Compose resolves every service to that one tag and refuses the file when the variable is unset, that the file has no `:latest`, that the services Compose starts by default are exactly the ones in `ci/smoke-services`, the list `ci/smoke-image.sh` starts, that every published port is on the host's 127.0.0.1 whatever `PHOTOGRAPHY_PORT` says and no service uses `network_mode: host`, that `web` mounts the data root once, read-only, and points `PHOTOGRAPHY_DATA_DIR` at it, and that every bind of the data root, the library, or `web`'s image cache has `create_host_path: false`. A PR that adds a service lists it in `ci/smoke-services` and extends the smoke test to check it.

`ci/smoke-image.sh` starts `web` and `image-watcher` from `docker-compose.prod.yml` on the image under test, with the two photos in `ci/fixtures/library/` as the library and an empty data root. It checks that `/` returns HTML, `/api/health` answers, `/api/photos` and `/api/ready` answer 503 with `registry-missing` before the migration, and the watcher passes its healthcheck, writes all seven derivatives for each photo, picks up a photo added while it runs, and never restarts. Then it runs the migration runbook in [data-root.md](data-root.md) as uid 1001, checks that `/api/photos` then lists every photo and `/api/ready` reports legacy mode, waits for the watcher to build every `/media` set, checks that `/media` serves none of them before the first activation and an original 404s, and that recreating the containers keeps every photo ID, `/media` URL, and set. Last, it runs the watcher with `PHOTOGRAPHY_DATA_DIR` unset and checks that it writes the legacy derivatives and no registry. Its only change to the Compose file is an override that binds `web` to 127.0.0.1. CI runs it on the image the PR built, and `Publish to GHCR` runs it again on the exact digest it pushed. To run it locally you need Docker with Compose 2.24.4 or later, for the override's `!override` tag, and a free port, 3000 unless you set `SMOKE_IMAGE_PORT`:

```bash
docker build -t ghcr.io/keyurgolani/keyurgolani.photography:ci-smoke .
ci/check-compose.sh
npm run smoke:image
```

`ci/smoke-catalog.sh` runs the image with `docker run` on two throwaway data roots. On the first, the image generates a fixture library from `test/fixtures`, `photos migrate` gives each photo its ID, and the watcher's `--once` run builds every derivative. `web` must then report legacy mode at `/api/ready`, list each photo once at `/api/photos` in the legacy item shape, serve each listed WebP, and answer the same after a restart. On the second, `ci/publish-fixture.ts` publishes a small test catalog, and `web` must name its revision at `/api/ready` and `/api/photos`, serve a set the revision holds from `/media` with `immutable`, its ETag, and a 304 to that ETag, and 404 a set no revision holds. After a restart on that root, `/api/ready` must answer exactly as before it, naming the same revision, and the set must still serve. `ci/publish-fixture.ts` runs on the machine, not in the image, so run `npm ci` first. `web` publishes a random port on 127.0.0.1:

```bash
npm run smoke:catalog
```

A PR runs its own copy of `ci.yml` and `ci/`, so a PR that edits `.github/workflows/`, `ci/`, or `.github/audit-allowlist.json` can weaken the check that gates it. Read those diffs by hand.

## The audit allowlist

`.github/audit-allowlist.json` is a JSON array, empty by default. Each entry lets one advisory through until it expires:

```json
[
  {
    "id": "GHSA-xxxx-xxxx-xxxx",
    "package": "next",
    "reason": "Why the advisory doesn't reach this site.",
    "expires": "YYYY-MM-DD"
  }
]
```

All four fields are required. `id` is the advisory's GHSA ID, or `npm:<number>` for an advisory without one, and `package` is the vulnerable package as `npm audit` names it. The entry covers that advisory through its `expires` date in UTC, which can be at most 90 days out, and the audit fails from the next day. Add one only when no release of the package, or of the parent that pins it, fixes the advisory, and try an npm `overrides` pin first. An entry that matches nothing only warns, so the PR that fixes the advisory stays green. Delete the entry in that PR or the next one.

## Dependency updates

Dependabot opens grouped weekly version updates against `next`, as `.github/dependabot.yml` sets up, and they go through the same CI and promotion as any other PR. Security updates, once they're turned on in Code security settings, always open against `main`, and the groups and ignores in `dependabot.yml` don't apply to them. Since `main` only moves by promotion, land a security PR's change through a PR into `next` and close it, and if one does get merged on `main`, merge `main` back into `next` before the next promotion.

## Rulesets

These live under Settings > Rules > Rulesets. `CI result` only shows up in the status check suggestions after it has run once.

Branch ruleset `main`:

1. Enforcement Active, targeting the default branch, with an empty bypass list.
2. Restrict deletions and Block force pushes.
3. Require a pull request before merging, with 0 required approvals, since GitHub doesn't let an author approve their own PR.
4. Require status checks to pass, with `CI result` from GitHub Actions. Leave "Require branches to be up to date before merging" off. `main` runs CI again after every merge, and that run gates publishing.
5. Under the pull request rule, set Allowed merge methods to Merge only, so every promotion is a merge commit and `next` and `main` keep one history.

Tag ruleset `release tags`:

1. Target tags matching `v*`, with Repository admin on the bypass list.
2. Restrict creations, Restrict updates, and Restrict deletions, so only the owner can cut, move, or delete a release tag.

With no bypass on `main`, the owner's changes go through PRs too. In an emergency, set the ruleset to Disabled, push, and set it back to Active.

## What `main` publishes

Every push to `main` runs `Publish image` (`.github/workflows/publish.yml`):

1. `ci` runs the same jobs as a PR.
2. `Publish to GHCR` runs only after CI passes. It pushes the image by digest, pulls that digest back, and runs `ci/smoke-image.sh` against it. Only then does it tag it `ghcr.io/keyurgolani/keyurgolani.photography:sha-<first 7 characters of the commit>`, so a `sha-` tag only ever exists for an image that passed the smoke test. A run that finds this commit's `sha-` tag already there reuses it instead of building again. The job summary has the digest and the `PHOTOGRAPHY_IMAGE_TAG=sha-...` line.
3. `Mirror to Docker Hub` copies that digest to `keyurgolani/keyurgolani.photography:sha-...` on Docker Hub.

`main` never writes `latest` or a version tag. Publishes run one at a time, in push order, and waiting runs queue instead of being dropped. To retry a failed one, use Re-run failed jobs.

The mirror needs the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets. Without them it warns and succeeds. A Docker Hub failure fails only the mirror job, never the GHCR publish or a release.

### When the audit blocks `main`

When `Production audit` fails in a `main` publish, that commit never gets a `sha-` tag, so it can't be released. Re-run failed jobs only helps when the advisory service was unreachable. For a new advisory or an expired allowlist entry:

1. Land a fix, or a dated allowlist entry, through a PR into `next`.
2. Promote `next` to `main` again, and wait for that merge's `Publish to GHCR` job to succeed.
3. If a release tag was already pushed on the blocked commit, delete it with the admin bypass on the tag ruleset, since every `vX.Y.Z` tag counts when deciding `latest`:

   ```bash
   git push origin --delete vX.Y.Z
   ```

4. Tag the new `main` commit.

## Cutting a release

Releases come from `main` only. Tag a `main` commit whose `Publish to GHCR` job succeeded, never a commit that is only on `next`.

1. Bump the version with `npm version X.Y.Z --no-git-tag-version` in a PR into `next` that changes nothing else. It sets `version` in `package.json` and both copies in `package-lock.json`. Plain `npm version` also commits and puts a local `vX.Y.Z` tag on that commit. Pushed, that tag isn't on `main`, so its release fails; kept, it blocks tagging the real `main` commit later.
2. Promote `next` to `main` through a PR, merged with a merge commit, and wait for that merge's `Publish to GHCR` job to succeed. A red Docker Hub mirror doesn't block a release. To retry a failed publish, use Re-run failed jobs. The publish job reuses the `sha-` image if it already exists.
3. Tag that `main` commit and push that one tag:

   ```bash
   git tag vX.Y.Z <main commit>
   git push origin vX.Y.Z
   ```

Never `git push --tags`. Never tag a commit from before this process existed, because its own `deploy.yml` still publishes `latest` the old way. If a release fails because the tag doesn't match `package.json`, delete that tag, because every `vX.Y.Z` tag counts when deciding `latest`.

The tag starts `Release` (`.github/workflows/release.yml`). Its `Promote release` job:

1. Runs `ci/release-plan.mjs`, which fails unless the tag is `vX.Y.Z` and matches `version` in `package.json` at the tagged commit. Pre-release tags such as `v1.2.0-rc.1` fail too. To try a build on the host before releasing it, pin its `sha-` tag.
2. Fails at once if the tagged commit isn't on `main`.
3. Waits up to 40 minutes for that commit's `Publish to GHCR` job to succeed. If the job failed or was skipped, the release fails without publishing anything. It also fails if no `Publish image` run for the commit shows up within about 5 minutes. A commit that reached `main` inside a merge never gets its own run, so tag the merge commit.
4. Looks up the digest of `sha-<commit>` and checks that its `org.opencontainers.image.revision` label is the tagged commit, since seven characters can collide.
5. Fails if GHCR already has `vX.Y.Z` with a different digest. The same digest means a re-run, which succeeds and changes nothing.
6. Reads the release tags on GitHub again and fails if the tag no longer names this commit, so deleting or moving a tag stops a release that is still waiting and it publishes nothing. Then it copies `sha-<commit>` to `vX.Y.Z`, and to `latest` when `vX.Y.Z` is the highest `vX.Y.Z` tag there, and checks that every new tag has the same digest. Versions compare as numbers, so `v0.10.0` beats `v0.9.0`, and pushing an old tag again never moves `latest` back.
7. Mirrors the same tags to Docker Hub by digest. Docker Hub `latest` only moves when GHCR `latest` has the same digest, so re-running an old release's mirror never moves it back.

Releases run one at a time, and waiting ones queue. The job summary shows the version, the digest, whether `latest` moved, and the `PHOTOGRAPHY_IMAGE_TAG=` line for the host.

## Deploying

Set the tag in the `.env` next to `docker-compose.prod.yml` on the host. Compose reads that file on its own.

```bash
PHOTOGRAPHY_IMAGE_TAG=vX.Y.Z
```

To pin the exact image too, add the digest from the release's job summary: `PHOTOGRAPHY_IMAGE_TAG=vX.Y.Z@sha256:<digest>`. Compose then pulls that digest whatever the tag names later.

Then pull and restart:

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Both services switch together. Every `docker compose -f docker-compose.prod.yml` command needs `PHOTOGRAPHY_IMAGE_TAG`, not just `up`, so `pull`, `ps`, `logs`, and `down` refuse to run without it too. A `PHOTOGRAPHY_IMAGE_TAG` exported in your shell overrides `.env`. Nothing pulls `:latest` anymore, so every release needs this `.env` edit.

`v1.1.0`, the first release with Phase 0 of [replacement and missing files (#17)](https://github.com/keyurgolani/keyurgolani.photography/issues/17), needs two one-time steps, and only with the new image running them. Before it, derivative URLs were marked `immutable` for a year, so `./.next-images-cache` holds `/_next/image` copies made under that header, and an older image refills it and has no `images:cleanup`. Deploy `v1.1.0` this way instead of the plain `pull` and `up -d`. The cache files belong to the container's uid 1001, and a host user's `rm` can fail on them, so the `rm` runs inside the new `web` image:

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml stop web
docker compose -f docker-compose.prod.yml run --rm --no-deps web sh -c 'rm -rf /app/.next/cache/images/*'
docker compose -f docker-compose.prod.yml up -d
```

Then run `images:cleanup` once, while the host still runs `v1.1.0` and its compose file, before upgrading. No later release has it: the first release with slice C of #10, whose image has no tsx, also has slice C of #13, which removes the script, so no image ships a bundled copy. Its dry run lists what the old pipeline left behind, including every `cache/dynamic` file from the removed `/api/image` route, and the second command deletes exactly that list:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher npx tsx scripts/imageCleanup.ts
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher npx tsx scripts/imageCleanup.ts --apply --plan <hash>
```

The first release with slice A of [stable photo identity (#10)](https://github.com/keyurgolani/keyurgolani.photography/issues/10) needs a step too. The Gallery grid and lightbox now show the derivatives instead of the original files, and derivatives written before it ignored the EXIF orientation, so a photo whose file carries an orientation tag shows turned or mirrored until its derivatives are rebuilt. The watcher rebuilds them by itself. The first time it starts on a library, it rebuilds the set of every photo with an orientation tag, and of every photo it can't read to tell, which it logs as unreadable. Once each of them is written or has failed, it records that in `cache/upright-rebuild.json` in the library, so later starts skip it. A photo that failed is listed there, and each start tries it again until it builds. If the watcher stops first, or a photo changes while it is rebuilt, the next start rebuilds them all again. The watcher has to be able to write `cache/`; it logs at start when it can't. The old derivatives keep serving until each photo's new set is written.

On a host that already ran a release with slice A, the watcher has already rebuilt them, so skip the rest of this step.

To see which photos it rebuilds, run the migration dry run the way the [migration runbook](data-root.md#migration-runbook) does, with `run --rm --no-deps` while the watcher is stopped, before the new watcher first starts. The deploy blocks for the first release with slice C, below, do that after their `pull`, before the migration and the `up -d` that follow them, with `node dist/scripts/photos.mjs migrate --dry-run`, since that image has no tsx. It changes nothing in the library, adds only a plan and a report under `identity/migration/` in the data root, and prints the report's path. Read the report once the block is done:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher cat <report path>
```

Its "Orientation-tagged files" section lists them, except any the library reaches through a symlink, since the dry run reads no file through one. If it says "None." and no photo in the library's top folder is a symlink, skip the rest. Otherwise wait for the watcher to log that it rebuilt them:

```bash
docker compose -f docker-compose.prod.yml logs image-watcher | grep -E 'orientation-tagged|unreadable'
```

Once it logs that it rebuilt the sets of the orientation-tagged photos, and of any unreadable ones, clear `./.next-images-cache` the same way as above, so `/_next/image` drops the copies it made from the old derivatives. If it also names photos that failed to rebuild, fix or remove those files, and clear the cache again once it logs that it rebuilt them. If this is also the first release with Phase 0, this one clear, after the rebuild, covers both.

The first release with slice C of [stable photo identity (#10)](https://github.com/keyurgolani/keyurgolani.photography/issues/10) needs the new `docker-compose.prod.yml` on the host, and the data root, `./portfolio-data`, and `./.next-images-cache` created and owned by uid 1001 before the first `up`. The old compose file runs the watcher with tsx, which the image no longer has, and the new one never creates a missing data root or image cache, so the containers don't start without them. A `./.next-images-cache` that Docker created for the old file belongs to root, and the `chown` in the blocks below hands it to uid 1001. The new file also publishes `web` on the host's 127.0.0.1 only, port `PHOTOGRAPHY_PORT` or 3000, so whatever serves the site to the internet has to reach it there, such as a reverse proxy or a tunnel running directly on the host. A proxy or tunnel that runs in a container can't: the host's 127.0.0.1 isn't its 127.0.0.1. Run it as a service in the override below instead, so it joins this project's network, and point it at `http://web:3000`. That service may publish 80 and 443 itself.

On that network, the proxy or tunnel reaches `web` by its service name or by a network alias. If its configured origin names another host, such as the service name an older compose file used, give `web` that name as an alias in the override, rather than changing the proxy's own configuration:

```yaml
services:
  web:
    networks:
      default:
        aliases:
          - <origin name>
```

`web` stays on the same `default` network, and the alias only adds a name for it there. A proxy that stays in a Compose project of its own has to join this project's `default` network as an external network before either name resolves.

Keep the host's current file, and find what this host changed in it. Compare it with the repository's file for the release the host runs now, `v<current>`, the tag you noted before changing `.env`, not with the new one, which also has the repository's own changes. Then fetch the new file beside it. The `[ -e ... ] ||` keeps the first copy if you run these again:

```bash
[ -e docker-compose.prod.yml.before-vX.Y.Z ] || cp -p docker-compose.prod.yml docker-compose.prod.yml.before-vX.Y.Z
curl -fsSL -o docker-compose.prod.yml.current https://raw.githubusercontent.com/keyurgolani/keyurgolani.photography/v<current>/docker-compose.prod.yml
diff -u docker-compose.prod.yml.current docker-compose.prod.yml.before-vX.Y.Z
curl -fsSL -o docker-compose.prod.yml.new https://raw.githubusercontent.com/keyurgolani/keyurgolani.photography/vX.Y.Z/docker-compose.prod.yml
```

If the diff shows changes made on this host, don't copy them into the new file:

- A different host port goes in `.env` as `PHOTOGRAPHY_PORT=<port>`, never in an override.
- Anything else, such as another service or photos path, goes in an override file that isn't in the repository, added to every command as `-f docker-compose.prod.yml -f <override>`, so the next release's file replaces cleanly. Compose adds an override's `ports:` to the file's instead of replacing them, so a `ports:` entry for `web` there has to start with `127.0.0.1:` and its list has to be tagged `!override` (Compose 2.24.4 or later), and `web` never takes `network_mode: host`. Otherwise `web` is published on every interface again. These rules are for `web` only. A reverse proxy service in the override may publish 80 and 443, or run with `network_mode: host` and point at `http://127.0.0.1:3000`.

A host whose boot service runs a plain `docker compose up`, with no `-f`, loads `docker-compose.yml`, and `docker-compose.override.yml` beside it whenever that exists. Keep that service and every command here on the same project: install the repository's file as `docker-compose.prod.yml`, as above, point `docker-compose.yml` at it with a symlink in the same folder, and name the override `docker-compose.override.yml`, which Compose loads on its own. This layout is for a deploy folder that isn't a git checkout of the repository. In a checkout, `docker-compose.yml` is the repository's dev stack, and a later `git pull`, `checkout`, or `reset` puts it back in place of the symlink, so the next boot starts the dev stack, as root, on the production library and data root.

If the host's file is a real `docker-compose.yml` today, rename it to `docker-compose.prod.yml` before the steps above, so the saved copy and the diff use it. The `-n` leaves a `docker-compose.prod.yml` that's already there alone, and the `ln` below then refuses too, so check which of the two is the host's file before going on:

```bash
mv -n docker-compose.yml docker-compose.prod.yml
```

Leave no `compose.yaml` or `compose.yml` in that folder, since Compose prefers them, and no `compose.override.yml` or `compose.override.yaml`, since Compose loads that one instead of `docker-compose.override.yml` when both exist. The `ln` refuses to replace a file that's there:

```bash
[ -L docker-compose.yml ] || ln -s docker-compose.prod.yml docker-compose.yml
```

The block's `mv` replaces the file the link points at, so the link keeps working. With this layout, use the override block below with `docker-compose.override.yml` as `<override>`, and run every other command in this guide either as plain `docker compose` or with both files, `-f docker-compose.prod.yml -f docker-compose.override.yml`. `-f docker-compose.prod.yml` alone leaves the override out, so its services don't start. Once the new file is in place, check that the plain command loads the override. This has to list `web`, `image-watcher`, and every service in the override, and `docker compose config` shows each one's settings:

```bash
docker compose config --services
```

If the host's file named a service differently from the repository's, for example, a name from a hand-written compose file, such as `<old-service>` where the repository's file has `web`, that service's container outlives the switch. Compose manages only the services its files name, so `up -d` leaves the old container running, still holding the port it published, and a new `web` on the same port fails to start. Before the block below, list this project's containers with their service names, and the services the new files name. Add `-f <override>` to the second command when you use one:

```bash
docker ps -a --filter "label=com.docker.compose.project=$(docker compose -f docker-compose.prod.yml.new config --format json | jq -r .name)" \
  --format '{{.ID}}\t{{.Label "com.docker.compose.service"}}\t{{.Names}}\t{{.Status}}'
docker compose -f docker-compose.prod.yml.new config --services
```

A container whose service the second list doesn't name is left from an old service name. Remove a watcher left from an old service name by its ID before the block. Removing an old `web` takes the site down until step 4's `up -d` below, after the dry run, the backup and the apply, so leave an old `web` running and add `--remove-orphans` to step 4's `up -d` instead. Removing a container leaves the photos, the data root, and the image cache alone, since they're folders on the host:

```bash
docker rm -f <ID>
```

`--remove-orphans` on step 4's `up -d` removes every container of this project whose service the files don't name, including one an earlier override started that this override no longer has. That `up -d` runs only after the migration, though, so remove a watcher left from an old service name with `docker rm -f` before the block either way. The block's `stop image-watcher` doesn't reach it, and it would keep writing the library while the dry run reads it.

Then install the new file, set up the data root and the image cache, stop the old watcher, and run the slice A dry run above, which is also the migration's dry run. The block stops there, before `up -d`, and the steps after it apply the migration and then deploy. Do it this way instead of the plain `pull` and `up -d`, and only after the `.env` edit. Each half of the switch needs the other: the plain commands would start the old file on the new image, whose watcher command needs tsx, and this block run on the old tag would start the new file on the old image, which has no `dist/scripts`. Either way the watcher crash-loops. So the block checks `.env` first, and stops before it changes anything when the tag isn't there yet. The check takes the tag alone or pinned to a digest, `vX.Y.Z@sha256:<digest>`, as one line with no quotes or spaces. In the `grep` pattern, put the version's digits in place of `X`, `Y`, and `Z` and keep the `\.` between them. The `exit` leaves only the block's subshell, not your shell. On a large library the dry run reads every photo and can take as long as a full identity pass, while the watcher is stopped and the old `web` keeps serving, so let it finish. If you stop it, run the block again: its `mv` reports that the `.new` file is gone, since the first run moved it in, and the rest runs as before:

```bash
(
  grep -Eqx 'PHOTOGRAPHY_IMAGE_TAG=vX\.Y\.Z(@sha256:[0-9a-f]{64})?' .env || { echo ".env doesn't set PHOTOGRAPHY_IMAGE_TAG=vX.Y.Z yet. Nothing was changed." >&2; exit 1; }
  mv docker-compose.prod.yml.new docker-compose.prod.yml
  mkdir -p portfolio-data .next-images-cache
  sudo chown -R 1001:1001 portfolio-data .next-images-cache
  sudo chmod 700 portfolio-data
  docker compose -f docker-compose.prod.yml pull
  docker compose -f docker-compose.prod.yml stop image-watcher
  docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs migrate --dry-run
)
```

With an override, use this block instead. It also checks the merged file, the new one with your override, before anything moves: `web` has to be published on 127.0.0.1 only and stay off the host's network. It needs `jq` on the host, and without it the check fails and stops the block too. The check reads the `.new` file, so when an earlier run already moved it in, as one stopped during the dry run did, the block says so and stops. Fetch the new file again with the `curl` line above and run the block again:

```bash
(
  grep -Eqx 'PHOTOGRAPHY_IMAGE_TAG=vX\.Y\.Z(@sha256:[0-9a-f]{64})?' .env || { echo ".env doesn't set PHOTOGRAPHY_IMAGE_TAG=vX.Y.Z yet. Nothing was changed." >&2; exit 1; }
  [ -e docker-compose.prod.yml.new ] || { echo "docker-compose.prod.yml.new is gone, so an earlier run already moved it in. Fetch it again and rerun this block. Nothing was changed." >&2; exit 1; }
  docker compose -f docker-compose.prod.yml.new -f <override> config --format json |
    jq -e '.services.web.network_mode == null and ([.services.web.ports[]?.host_ip] | unique) == ["127.0.0.1"]' >/dev/null ||
    { echo "With the override, web isn't published on 127.0.0.1 only. Fix the override. Nothing was changed." >&2; exit 1; }
  mv docker-compose.prod.yml.new docker-compose.prod.yml
  mkdir -p portfolio-data .next-images-cache
  sudo chown -R 1001:1001 portfolio-data .next-images-cache
  sudo chmod 700 portfolio-data
  docker compose -f docker-compose.prod.yml -f <override> pull
  docker compose -f docker-compose.prod.yml -f <override> stop image-watcher
  docker compose -f docker-compose.prod.yml -f <override> run --rm --no-deps image-watcher node dist/scripts/photos.mjs migrate --dry-run
)
```

The block leaves the old `web` serving and the watcher stopped. The first release with slice C of #10 is also the first with slice C of [#13](https://github.com/keyurgolani/keyurgolani.photography/issues/13), whose `web` lists photos only from the registry the migration writes, so apply the migration now, before `up -d`. Started first, the new `web` shows no photos on Home and Gallery until it applies. The old image can't run the migration, since it has no `dist/scripts/photos.mjs`, so these steps run the new image through the new compose file, as the block's dry run did, with the old watcher still stopped. With an override, add `-f <override>` after `-f docker-compose.prod.yml` in each command:

1. Back up both folders. This is the [Backing up](data-root.md#backing-up) block without its `stop` and `start`, since the watcher is already stopped and its `start` would bring the old watcher back while step 3 applies the plan:

   ```bash
   (
     for d in public/assets/photos portfolio-data; do
       [ -d "$d" ] && [ ! -L "$d" ] || { echo "$d must be a real folder, not a symlink. Nothing was archived." >&2; exit 1; }
     done
     mkdir -m 700 -p ~/photography-backups
     (umask 077 && sudo tar -czf - public/assets/photos portfolio-data >~/photography-backups/photography-$(date -u +%Y%m%dT%H%M%SZ).tar.gz)
   )
   ```

2. Read the report the block's dry run printed, and check what step 3 of the runbook lists.
3. Apply the plan the dry run printed, as step 4 of the runbook does. If it refuses because the library changed since the dry run, run the block's dry run line again, read its new report as in step 2, and apply that plan:

   ```bash
   docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs migrate --apply --plan <plan path>
   ```

4. Start the new stack, in place of step 5 of the runbook:

   ```bash
   docker compose -f docker-compose.prod.yml up -d
   ```

5. Check the watcher's progress as step 6 of the runbook says.

Once it's up, check the site from the host, on `PHOTOGRAPHY_PORT` if you set one, and then through the public URL:

```bash
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS https://<public host>/api/health
```

If the first answers and the second doesn't, the proxy or tunnel can't reach `web`. One in a container needs the `http://web:3000` setup above.

[Setting it up](data-root.md#setting-it-up) in data-root.md is the same setup as the block, and the steps after the block are its [migration runbook](data-root.md#migration-runbook), in an order that keeps the old `web` serving until the registry is written.

The first release with slice C of the [atomic catalog publish (#13)](https://github.com/keyurgolani/keyurgolani.photography/issues/13) lists `/api/photos` from the data root's registry instead of reading the library. On a data root the migration hasn't initialized, `/api/photos` and `/api/ready` answer 503 with `registry-missing`, and Home and Gallery show no photos. That's why the steps after the deploy blocks above apply the migration before their `up -d`. Once it's up, check that the site is ready:

```bash
curl -s http://127.0.0.1:3000/api/ready
```

It should report `"mode":"legacy"` and `"state":"ok"`. Until a catalog revision is published, `/media` serves no set and the site keeps serving the legacy derivatives.

## Rollback

Before changing `.env`, note the tag the host runs now. To roll back, set `PHOTOGRAPHY_IMAGE_TAG` back to that tag and run the same two commands. That swaps the code, not the photo library. Rolling back to a release before Phase 0 of #17 brings back the watcher's startup cleanup, which deletes the derivative sets this release keeps for removed photos. That older release also refills `./.next-images-cache` under its year-long headers and writes new `cache/dynamic` files, so roll forward again the way Deploying describes for `v1.1.0`.

Rolling back past the first release with slice C of #10 needs the compose file the host ran before it too, since that older image has no `dist/scripts` for this file's watcher command. Put back the copy that release's deploy step saved, `docker-compose.prod.yml.before-vX.Y.Z`, rather than the repository's older file, so the host's own changes come back with it. Leave out of the override whatever only moved there from that copy, since the copy already has it. Restore the file first, then set the older tag in `.env`, then run the two commands.

That copy publishes `web` the way the host did before, which for the repository's older file is `"3000:3000"`, every interface. The older image doesn't care which address it's published on, so if the proxy or tunnel reaches `web` on the host's loopback, keep it there: the `sed` line changes `"3000:3000"` to `"127.0.0.1:3000:3000"` before `up -d`, and the `grep` after it shows the line it left. Leave both lines out only when something reaches `web` from another machine:

```bash
cp -p docker-compose.prod.yml.before-vX.Y.Z docker-compose.prod.yml
sed -i 's/^\([[:space:]]*- "\)3000:3000"/\1127.0.0.1:3000:3000"/' docker-compose.prod.yml
grep -n '3000:3000' docker-compose.prod.yml
# set PHOTOGRAPHY_IMAGE_TAG in .env back to the older tag
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Leave `./portfolio-data` where it is. Older releases never read it, and once you roll forward, the watcher's next pass catches up with what changed in the library meanwhile. A release that finds a data root written by a newer one, with a schema it doesn't know, treats it as unavailable and runs only the legacy step.

Rolling back past the first release with slice C of #13 lists `/api/photos` from the library again, and ignores any catalog revision published since. Rolling forward serves the active revision again.

An image older than the first release with slice A of #10 serves photos the way that release replaced, without its privacy protections. After the catalog launch, roll the image back that far only as a last resort, and prefer `photos rollback` or a data-root restore, as [After the catalog launch](#after-the-catalog-launch) describes.

Never roll back to `v1.0.0`. That image, on GHCR and on Docker Hub, is the initial commit and can't run under this compose file.

### After the catalog launch

`photos rollback` moves between published revisions only, to one that was live before. Right after the launch publish there is one revision, so it has no target. To get out of a bad launch revision, publish a corrected one. Once two revisions have gone live, a rollback can go back to the earlier one. No rollback brings back the legacy Home and Gallery.

Once an activation is committed, the site stays in catalog mode. `web` switches as soon as `catalog/active/` holds a pointer or a committed activation exists, and the running process keeps catalog mode until it restarts, even if both go away. So the site never goes back to the legacy pages by itself.

Only two things bring them back:

- Restoring the data root from a backup made before the launch publish, as [Restoring](data-root.md#restoring) describes. Its blocks stop and start `web`, so it comes back reading the restored data root, which has no pointer and no committed activation, and `/api/ready` reports `"mode":"legacy"`. That costs every authored change, publish, and rollback made after the backup, though the blocks keep the current data root aside. Photos added since the backup also get new IDs at the watcher's next pass, so their shared Viewer URLs stop resolving. So make the backup, as [Backing up](data-root.md#backing-up) describes, after authoring, `validate`, and the dry run, just before `--confirm-launch`. Restoring that one keeps the authored records, since a candidate and its diagnostics alone don't count as a cutover.
- Rolling the image back past the first release with slice C of #13, as above. Rolling forward serves the active revision again. An image older than the first release with slice A of #10 also goes without that release's privacy protections, as above, so roll back that far only as a last resort.

## What's running

The image a container runs:

```bash
docker inspect --format '{{.Config.Image}}' <container>
```

`docker compose -f docker-compose.prod.yml images` lists it too, but older Compose versions show the wrong tag there.

The commit a container was built from:

```bash
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' <container>
```

From the first `Publish image` build on, the `org.opencontainers.image.version` label is `v` plus the `package.json` version the image was built with, for example `v1.1.0`. Every `main` build carries it, released or not, so only a `vX.Y.Z` tag on GHCR shows that a digest is that release. Images from the old `deploy.yml` say `latest` there for `main` builds, including the one the host ran before `v1.1.0`, and the tag name for tag builds, such as `v0.4.2`.
