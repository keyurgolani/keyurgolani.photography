# Releasing and deploying

Production runs one release tag for both containers. A release copies the image `main` already built and tested, so the digest you deploy is the one CI checked. Releases never rebuild.

## What CI checks

Every pull request runs `.github/workflows/ci.yml`, whether it targets `main` or `next`:

| Job | What it does |
|---|---|
| `Lint, unit tests, build` | Checks that the `Dockerfile` base image matches `.nvmrc`, then runs `npm ci`, `npm run lint`, `npm test -- --run`, and `npm run build`. |
| `Browser tests` | Runs `npm run test:e2e` with Playwright. Until `package.json` has that script, it passes with a notice. |
| `Image smoke test` | Runs `ci/check-compose.sh`, builds the image, and runs `ci/smoke-image.sh` against it. |
| `CI result` | Fails unless all three jobs above succeeded. |

`CI result` is the only required check. A new push to a PR cancels its running CI. `next build` downloads Inter and Montserrat from Google Fonts, so a Google Fonts outage turns CI red until the fonts are self-hosted.

`ci/check-compose.sh` checks that every service in `docker-compose.prod.yml` takes its tag from `PHOTOGRAPHY_IMAGE_TAG`, that Compose refuses the file when the variable is unset, and that the file has no `:latest`.

`ci/smoke-image.sh` starts `web` and `image-watcher` from `docker-compose.prod.yml` on the image the PR built, with the two photos in `ci/fixtures/library/` as the library. It checks that `/` returns HTML, `/api/photos` returns a JSON array, and the watcher writes all seven derivatives for each photo. To run it locally you need Docker and a free port 3000:

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
3. Require a pull request before merging, with 0 required approvals, since GitHub doesn't let an author approve his own PR.
4. Require status checks to pass, with `CI result` from GitHub Actions. Leave "Require branches to be up to date before merging" off. `main` runs CI again after every merge, and that run gates publishing.

Tag ruleset `release tags`:

1. Target tags matching `v*`, with Repository admin on the bypass list.
2. Restrict creations, Restrict updates, and Restrict deletions, so only the owner can cut, move, or delete a release tag.

With no bypass on `main`, the owner's changes go through PRs too. In an emergency, set the ruleset to Disabled, push, and set it back to Active.

## What `main` publishes

Every push to `main` runs `Publish image` (`.github/workflows/deploy.yml`):

1. `ci` runs the same jobs as a PR.
2. `Publish to GHCR` runs only after CI passes. It pushes `ghcr.io/keyurgolani/keyurgolani.photography:sha-<first 7 characters of the commit>` and writes the digest and the `PHOTOGRAPHY_IMAGE_TAG=sha-...` line to the job summary.
3. `Mirror to Docker Hub` copies that digest to `keyurgolani/keyurgolani.photography:sha-...` on Docker Hub.

`main` never writes `latest` or a version tag. Publishes run one at a time, in push order. To retry a failed one, use Re-run jobs.

The publish builds from the layer cache the CI image job just filled, so it gets the tested layers with a digest of its own. On a cache miss it builds from scratch, and that image never ran the smoke test.

When merges land close together, GitHub cancels a `Publish image` run that is still waiting once a newer one queues behind it. That commit gets no `sha-` image, so tag the newest green merge instead. `Release` runs queue the same way, so re-run one that got dropped.

The mirror needs the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets. Without them it warns and succeeds. A Docker Hub failure fails only the mirror job, never the GHCR publish or a release.

## Cutting a release

1. Bump `version` in `package.json` in a PR, like the [v0.4.1 release commit](https://github.com/keyurgolani/keyurgolani.photography/commit/c5353deb4c10fdaad6fdc6dc17ae4eec55458422), and merge it.
2. Wait for that merge's `Publish image` run to go green.
3. Tag the merge commit and push that one tag:

   ```bash
   git tag vX.Y.Z <merge commit>
   git push origin vX.Y.Z
   ```

Never `git push --tags`. Never tag a commit from before this process existed, because its own `deploy.yml` still publishes `latest` the old way.

The tag starts `Release` (`.github/workflows/release.yml`). Its `Promote release` job:

1. Runs `ci/release-plan.mjs`, which fails unless the tag is `vX.Y.Z` and matches `version` in `package.json` at the tagged commit. Pre-release tags such as `v1.2.0-rc.1` fail too. To try a build on the host before releasing it, pin its `sha-` tag.
2. Waits up to 40 minutes for that commit's `Publish to GHCR` job. If the job failed, was skipped, or never ran, the release fails without publishing anything.
3. Fails if GHCR already has `vX.Y.Z` with a different digest. The same digest means a re-run, which succeeds and changes nothing.
4. Copies `sha-<commit>` to `vX.Y.Z`, and to `latest` when `vX.Y.Z` is the highest `vX.Y.Z` tag in the repository, then checks that every new tag has the same digest. Versions compare as numbers, so `v0.10.0` beats `v0.9.0`, and pushing an old tag again never moves `latest` back.
5. Mirrors the same tags to Docker Hub by digest.

The job summary shows the version, the digest, whether `latest` moved, and the `PHOTOGRAPHY_IMAGE_TAG=` line for the host.

## Deploying

Set the tag in the `.env` next to `docker-compose.prod.yml` on the host. Compose reads that file on its own.

```bash
PHOTOGRAPHY_IMAGE_TAG=v1.1.0
```

Then pull and restart:

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

Both services switch together. Nothing pulls `:latest` anymore, so every release needs this `.env` edit, and Compose refuses to start while `PHOTOGRAPHY_IMAGE_TAG` is unset.

## Rollback

Set `PHOTOGRAPHY_IMAGE_TAG` to the previous release tag and run the same two commands. That swaps the code, not the photo library. Whether an older release can read data a newer one wrote is part of [stable photo identity (#10)](https://github.com/keyurgolani/keyurgolani.photography/issues/10).

## What's running

The tag each container runs:

```bash
docker compose -f docker-compose.prod.yml images
```

The commit a container was built from:

```bash
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' <container>
```

## Rollout

The one-time move from `:latest` to pinned tags:

1. Open the PR that adds this process. After its first CI run, apply the two rulesets above, then merge the PR through the new check.
2. The merge's `Publish image` run pushes `sha-<merge commit>`. `latest` stays where it is.
3. On the host, before pulling the new `docker-compose.prod.yml`, read the running commit with the `docker inspect` command above and set `PHOTOGRAPHY_IMAGE_TAG=sha-<its first 7 characters>` in `.env`. Then `pull` and `up -d`. Visitors see no change.
4. Cut the first gated release, `v1.1.0`, with a PR that sets `version` to `1.1.0` and then the tag on its merge commit. `latest` moves to it.
5. On the host, set `PHOTOGRAPHY_IMAGE_TAG=v1.1.0`, then `pull` and `up -d`.

The first gated release is `v1.1.0` because a stray `v1.0.0` tag on the initial commit is the highest tag today. To stay on 0.x instead, delete `v1.0.0` on GitHub before the first release and cut `v0.5.0`.
