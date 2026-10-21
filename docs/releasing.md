# Releasing and deploying

Production runs one release tag for both containers. `main` tags an image `sha-<commit>` only after CI passes and that exact image passes the smoke test, and a release copies that digest. Releases never rebuild.

## What CI checks

Every pull request runs `.github/workflows/ci.yml`, whether it targets `main` or `next`:

| Job | What it does |
|---|---|
| `Lint, unit tests, build` | Checks that `.nvmrc` holds a bare Node major and the `Dockerfile` base image matches it, then runs `npm ci`, `npm run lint`, `npm test -- --run`, `npm run build`, `ci/check-standalone.sh`, and `npm run smoke:media`. `ci/check-standalone.sh` fails if the build copied project sources, the default data root, or the library into `.next/standalone`. `npm run smoke:media` migrates a generated fixture library into a temp data root, builds its sets with the watcher's `--once`, and checks that the build's `/media` route serves them, including one built after the server started. |
| `Browser tests` | Runs `npm run test:e2e`, which builds and serves the site against an empty temp photo library and runs `e2e/` in Chromium on a desktop and a Pixel 7 project. A failed run uploads `playwright-report/` and `test-results/`. |
| `Image smoke test` | Runs `ci/check-compose.sh`, builds the image, checks that it runs the Node major in `.nvmrc`, and runs `ci/smoke-image.sh` against it. Then it runs `ci/smoke-watcher-once.sh`, which checks that the image ships the bundled scripts and no dev dependencies or tsx, has the image's node generate a fixture library from the checkout's `test/fixtures`, runs the image's watcher with `--once` on it, checks that it deletes nothing after a photo is removed and exits 1 on a missing library, and checks the web server's image routes. |
| `Production audit` | Runs `ci/audit-gate.mjs`, which runs `npm audit --omit=dev` and fails on a high or critical advisory that `.github/audit-allowlist.json` doesn't list. It reads only the lockfile, so it skips `npm ci`. |
| `CI result` | Fails unless all four jobs above succeeded. |

`CI result` is the only required check. A new push to a PR cancels its running CI. `next build` downloads Inter and Montserrat from Google Fonts, so a Google Fonts outage turns CI red until the fonts are self-hosted.

`Production audit` can also turn CI red with no code change. That happens when the npm advisory service is unreachable, when a new high or critical advisory lands on a production dependency, or when an allowlist entry expires. Each of these also fails the `ci` job of a `main` publish, so nothing publishes and no release can be cut until it's fixed. [When the audit blocks `main`](#when-the-audit-blocks-main) covers the recovery.

`ci/check-compose.sh` checks that every image line in `docker-compose.prod.yml` is exactly `ghcr.io/keyurgolani/keyurgolani.photography:${PHOTOGRAPHY_IMAGE_TAG:?...}`, that Compose resolves every service to that one tag and refuses the file when the variable is unset, that the file has no `:latest`, and that the services Compose starts by default are exactly the ones in `ci/smoke-services`, the list `ci/smoke-image.sh` starts. A PR that adds a service lists it there and extends the smoke test to check it.

`ci/smoke-image.sh` starts `web` and `image-watcher` from `docker-compose.prod.yml` on the image under test, with the two photos in `ci/fixtures/library/` as the library and an empty data root. It checks that `/` returns HTML, `/api/photos` returns a JSON array, `/api/health` answers, and the watcher passes its healthcheck, writes all seven derivatives for each photo, picks up a photo added while it runs, and never restarts. Then it runs the migration runbook in [data-root.md](data-root.md) as uid 1001, waits for the watcher to build every `/media` set, checks that `/media` serves them and an original 404s, and that recreating the containers keeps every photo ID and ETag. Last, it runs the watcher with `PHOTOGRAPHY_DATA_DIR` unset and checks that it writes the legacy derivatives and no registry. Its only change to the Compose file is an override that turns on `PHOTOGRAPHY_MEDIA_ACCESS=all` and binds `web` to 127.0.0.1. CI runs it on the image the PR built, and `Publish to GHCR` runs it again on the exact digest it pushed. To run it locally you need Docker with Compose 2.24.4 or later, for the override's `!override` tag, and a free port, 3000 unless you set `SMOKE_IMAGE_PORT`:

```bash
docker build -t ghcr.io/keyurgolani/keyurgolani.photography:ci-smoke .
ci/check-compose.sh
npm run smoke:image
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

Then run `images:cleanup` once. Its dry run lists what the old pipeline left behind, including every `cache/dynamic` file from the removed `/api/image` route, and the second command deletes exactly that list:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/imageCleanup.mjs
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/imageCleanup.mjs --apply --plan <hash>
```

The first release with slice A of [stable photo identity (#10)](https://github.com/keyurgolani/keyurgolani.photography/issues/10) needs a step too. The Gallery grid and lightbox now show the derivatives instead of the original files, and derivatives written before it ignored the EXIF orientation, so a photo whose file carries an orientation tag shows turned or mirrored until its derivatives are rebuilt. The watcher rebuilds them by itself. The first time it starts on a library, it rebuilds the set of every photo with an orientation tag, and once all of them are written it records that in `cache/upright-rebuild.json` in the library, so later starts skip it. If one fails, or the watcher stops first, the next start rebuilds them again. The old derivatives keep serving until each photo's new set is written.

To see which photos it rebuilds, run the dry run after `up -d`. It changes nothing in the library and prints the path of its report:

```bash
docker compose -f docker-compose.prod.yml exec image-watcher node dist/scripts/photos.mjs migrate --dry-run --out /tmp/photo-migration
docker compose -f docker-compose.prod.yml exec image-watcher cat <report path>
```

Its "Orientation-tagged files" section lists them, except any the library reaches through a symlink, since the dry run reads no file through one. If it says "None." and no photo in the library's top folder is a symlink, skip the rest. Otherwise wait for the watcher to log that it rebuilt them:

```bash
docker compose -f docker-compose.prod.yml logs image-watcher | grep orientation-tagged
```

Once it logs that it rebuilt the sets of the orientation-tagged photos, clear `./.next-images-cache` the same way as above, so `/_next/image` drops the copies it made from the old derivatives. If this is also the first release with Phase 0, this one clear, after the rebuild, covers both.

The first release with slice C of [stable photo identity (#10)](https://github.com/keyurgolani/keyurgolani.photography/issues/10) needs the new `docker-compose.prod.yml` on the host, and the data root, `./portfolio-data`, created and owned by uid 1001 before the first `up`. The old compose file runs the watcher with tsx, which the image no longer has, and the new one never creates a missing data root, so neither container starts without it:

```bash
curl -fsSLO https://raw.githubusercontent.com/keyurgolani/keyurgolani.photography/vX.Y.Z/docker-compose.prod.yml
mkdir -p portfolio-data
sudo chown -R 1001:1001 portfolio-data
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

[Setting it up](data-root.md#setting-it-up) in data-root.md is the same step. The site keeps serving the legacy derivatives, and the watcher's identity step stays off until the [migration runbook](data-root.md#migration-runbook) there initializes the data root. Back up first, then run it whenever you're ready.

## Rollback

Before changing `.env`, note the tag the host runs now. To roll back, set `PHOTOGRAPHY_IMAGE_TAG` back to that tag and run the same two commands. That swaps the code, not the photo library. Rolling back to a release before Phase 0 of #17 brings back the watcher's startup cleanup, which deletes the derivative sets this release keeps for removed photos. That older release also refills `./.next-images-cache` under its year-long headers and writes new `cache/dynamic` files, so roll forward again the way Deploying describes for `v1.1.0`.

Rolling back past the first release with slice C of #10 needs that older release's `docker-compose.prod.yml` too, since its image has no `dist/scripts` for this file's watcher command. Leave `./portfolio-data` where it is. Older releases never read it, and once you roll forward, the watcher's next pass catches up with what changed in the library meanwhile. A release that finds a data root written by a newer one, with a schema it doesn't know, treats it as unavailable and runs only the legacy step.

Never roll back to `v1.0.0`. That image, on GHCR and on Docker Hub, is the initial commit and can't run under this compose file.

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

From the first `Publish image` build on, the `org.opencontainers.image.version` label is `v` plus the `package.json` version the image was built with, for example `v1.1.0`. Every `main` build carries it, released or not, so only a `vX.Y.Z` tag on GHCR shows that a digest is that release. Images from the old `deploy.yml` say `latest` there for `main` builds, including the one the host runs before the rollout, and the tag name for tag builds, such as `v0.4.2`.

## Rollout

PRs merge into `next`, and `main` only moves when the owner promotes `next` to it through a PR. The one-time move from `:latest` to pinned tags, with `next` already at version `1.1.0`:

1. Right before promoting, apply the two rulesets above.
2. Open a PR from `next` to `main`. Its `CI result` must pass. Merge it, as a merge commit.
3. That merge's `Publish image` run pushes the first `sha-<merge commit>`. `latest` stays where it is.
4. In the Actions tab, disable the old "Build and Publish Docker Image" workflow. It lives at the old `.github/workflows/deploy.yml` path, which older refs still carry, so a tag push or a manual run there would still publish `latest`.
5. On the host, before pulling the new `docker-compose.prod.yml`, pin exactly what it runs now. Read the running image's digest and the commit it was built from:

   ```bash
   docker inspect --format '{{index .RepoDigests 0}}' "$(docker inspect --format '{{.Image}}' <container>)"
   docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' <container>
   ```

   Set `PHOTOGRAPHY_IMAGE_TAG=sha-<first 7 characters of the commit>@<digest>` in `.env`, where `<digest>` is the `sha256:...` part of the first command's output. The old workflow built tagged commits twice with different digests, so the digest is what keeps the host on the exact image it runs. Then `pull` and `up -d`. Both containers restart briefly.
6. Once step 3's `Publish to GHCR` job has succeeded, tag that merge commit `v1.1.0` and push the tag, as in Cutting a release. `latest` moves to it.
7. On the host, set `PHOTOGRAPHY_IMAGE_TAG=v1.1.0` and deploy it the way Deploying describes for `v1.1.0`, with its one-time cache clear and `images:cleanup`.

The first gated release is `v1.1.0` because a stray `v1.0.0` tag on the initial commit is the highest tag today. To stay on 0.x instead, bump to `0.5.0` as in step 1 of Cutting a release, and delete the `v1.0.0` tag on GitHub before tagging `v0.5.0`. Read `v0.5.0` wherever the steps above, Deploying and Rollback say `v1.1.0`. The old `v1.0.0` image stays on GHCR after the tag is gone, so a later real `v1.0.0` release is refused until that package version is deleted too.
