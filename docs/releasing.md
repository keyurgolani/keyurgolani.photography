# Releasing and deploying

Production runs one release tag for both containers. `main` tags an image `sha-<commit>` only after CI passes and that exact image passes the smoke test, and a release copies that digest. Releases never rebuild.

## What CI checks

Every pull request runs `.github/workflows/ci.yml`, whether it targets `main` or `next`:

| Job | What it does |
|---|---|
| `Lint, unit tests, build` | Checks that `.nvmrc` holds a bare Node major and the `Dockerfile` base image matches it, then runs `npm ci`, `npm run lint`, `npm test -- --run`, and `npm run build`. |
| `Browser tests` | Runs `npm run test:e2e` with Playwright. Until `package.json` has that script, it passes with a notice. |
| `Image smoke test` | Runs `ci/check-compose.sh`, builds the image, and runs `ci/smoke-image.sh` against it. |
| `CI result` | Fails unless all three jobs above succeeded. |

`CI result` is the only required check. A new push to a PR cancels its running CI. `next build` downloads Inter and Montserrat from Google Fonts, so a Google Fonts outage turns CI red until the fonts are self-hosted.

`ci/check-compose.sh` checks that every image line in `docker-compose.prod.yml` is exactly `ghcr.io/keyurgolani/keyurgolani.photography:${PHOTOGRAPHY_IMAGE_TAG:?...}`, that Compose resolves every service to that one tag and refuses the file when the variable is unset, that the file has no `:latest`, and that the services Compose starts by default are the ones `ci/smoke-image.sh` starts. A PR that adds a service extends the smoke test.

`ci/smoke-image.sh` starts `web` and `image-watcher` from `docker-compose.prod.yml` on the image under test, with the two photos in `ci/fixtures/library/` as the library. It checks that `/` returns HTML, `/api/photos` returns a JSON array, and the watcher writes all seven derivatives for each photo, picks up a photo added while it runs, and never restarts. CI runs it on the image the PR built, and `Publish to GHCR` runs it again on the exact digest it pushed. To run it locally you need Docker and a free port 3000:

```bash
docker build -t ghcr.io/keyurgolani/keyurgolani.photography:ci-smoke .
ci/check-compose.sh
ci/smoke-image.sh ci-smoke
```

A PR runs its own copy of `ci.yml` and `ci/`, so a PR that edits `.github/workflows/` or `ci/` can weaken the check that gates it. Read those diffs by hand.

## Rulesets

These live under Settings > Rules > Rulesets. `CI result` only shows up in the status check suggestions after it has run once.

Branch ruleset `main`:

1. Enforcement Active, targeting the default branch, with an empty bypass list.
2. Restrict deletions and Block force pushes.
3. Require a pull request before merging, with 0 required approvals, since GitHub doesn't let an author approve their own PR.
4. Require status checks to pass, with `CI result` from GitHub Actions. Leave "Require branches to be up to date before merging" off. `main` runs CI again after every merge, and that run gates publishing.

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

## Cutting a release

Releases come from `main` only. Tag a `main` commit whose `Publish to GHCR` job succeeded, never a commit that is only on `next`.

1. Bump `version` in `package.json` in a PR into `next`, like the [v0.4.1 release commit](https://github.com/keyurgolani/keyurgolani.photography/commit/c5353deb4c10fdaad6fdc6dc17ae4eec55458422).
2. Promote `next` to `main` through a PR, and wait for that merge's `Publish to GHCR` job to succeed. A red Docker Hub mirror doesn't block a release. To retry a failed publish, use Re-run failed jobs. The publish job reuses the `sha-` image if it already exists.
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
6. Reads the release tags on GitHub again, then copies `sha-<commit>` to `vX.Y.Z`, and to `latest` when `vX.Y.Z` is the highest `vX.Y.Z` tag there, and checks that every new tag has the same digest. Versions compare as numbers, so `v0.10.0` beats `v0.9.0`, and pushing an old tag again never moves `latest` back.
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

## Rollback

Before changing `.env`, note the tag the host runs now. To roll back, set `PHOTOGRAPHY_IMAGE_TAG` back to that tag and run the same two commands. That swaps the code, not the photo library. Whether an older release can read data a newer one wrote is part of [stable photo identity (#10)](https://github.com/keyurgolani/keyurgolani.photography/issues/10).

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

## Rollout

PRs merge into `next`, and `main` only moves when the owner promotes `next` to it through a PR. The one-time move from `:latest` to pinned tags:

1. Merge the PR that adds this process into `next` through its `CI result`.
2. Right before promoting, apply the two rulesets above.
3. Open a PR from `next` to `main`. Its `CI result` must pass. Merge it.
4. That merge's `Publish image` run pushes the first `sha-<merge commit>`. `latest` stays where it is.
5. In the Actions tab, disable the old "Build and Publish Docker Image" workflow. It lives at the old `.github/workflows/deploy.yml` path, which older refs still carry, so a tag push or a manual run there would still publish `latest`.
6. On the host, before pulling the new `docker-compose.prod.yml`, pin exactly what it runs now. Read the running image's digest and the commit it was built from:

   ```bash
   docker inspect --format '{{index .RepoDigests 0}}' "$(docker inspect --format '{{.Image}}' <container>)"
   docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' <container>
   ```

   Set `PHOTOGRAPHY_IMAGE_TAG=sha-<first 7 characters of the commit>@<digest>` in `.env`, where `<digest>` is the `sha256:...` part of the first command's output. The old workflow built tagged commits twice with different digests, so the digest is what keeps the host on the exact image it runs. Then `pull` and `up -d`. Both containers restart briefly.
7. Cut the first gated release, `v1.1.0`. Set `version` to `1.1.0` in a PR into `next`, promote `next` to `main`, and once that merge's `Publish to GHCR` succeeds, tag it `v1.1.0`. `latest` moves to it.
8. On the host, set `PHOTOGRAPHY_IMAGE_TAG=v1.1.0`, then `pull` and `up -d`.

The first gated release is `v1.1.0` because a stray `v1.0.0` tag on the initial commit is the highest tag today. To stay on 0.x instead, delete the `v1.0.0` tag on GitHub before the first release and cut `v0.5.0`. The old `v1.0.0` image stays on GHCR after the tag is gone, so a later real `v1.0.0` release is refused until that package version is deleted too.
