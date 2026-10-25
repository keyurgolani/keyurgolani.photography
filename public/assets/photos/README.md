# Photos Directory

This directory is where gallery photos should be placed.

## Usage

1. Add your photos (JPG, JPEG, PNG, WEBP) to this directory
2. The gallery loads them through `/api/photos` once the watcher has written all seven of their derivatives. The original files are never served.
3. Photos are sorted by date taken (newest first), extracted from EXIF metadata

## Replacing and Removing Photos

- Saving over a photo under the same name regenerates its derivatives. The old ones keep serving until all seven new ones are written. `/_next/image` can serve the old version for up to a day, and a browser that cached it under the old `immutable` header may keep it for up to a year.
- Accepted risk: a different photo saved under a removed photo's name, with an older modification time, shows the old images until you `touch` it or run `--force`. Copy tools that keep modification times, such as `cp -p` and `rsync -a`, do this. With the watcher stopped, run `images:cleanup` before reusing a name.
- Deleting a photo hides it from the gallery, but its derivative files stay reachable at their URLs until `images:cleanup` deletes them. Restoring the file brings it back in the gallery after `web` restarts, since Next serves only the `public/` files that existed when it started.
- `npm run images:cleanup` lists derivatives no photo needs anymore, with the reason for each, and prints a plan hash. It deletes them only when re-run with `-- --apply --plan <hash>`. In production:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher npx tsx scripts/imageCleanup.ts
```

- To take a photo down:
  1. Stop `image-watcher`, so a job already running can't write its derivatives back, then delete the photo.
  2. Run the full dry run, which also lists sets left under the photo's earlier names.
  3. Run it with `--only <name>`, where `<name>` is the photo's exact name such as `landscape`, then apply that plan. Do the same for each earlier name. If either step exits 1 and names a folder it couldn't look in, remove the photo's files from that folder by hand.
  4. Purge Next's image cache inside the `web` image, since its files belong to uid 1001, then start the stack.
  5. Wait about two minutes and check that `/api/photos` no longer lists the photo, since its cached list survives a restart.

```bash
docker compose -f docker-compose.prod.yml stop image-watcher
# Delete the photo, then:
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher npx tsx scripts/imageCleanup.ts
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher npx tsx scripts/imageCleanup.ts --only <name>
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher npx tsx scripts/imageCleanup.ts --only <name> --apply --plan <hash>
docker compose -f docker-compose.prod.yml stop web
docker compose -f docker-compose.prod.yml run --rm --no-deps web sh -c 'rm -rf /app/.next/cache/images/*'
docker compose -f docker-compose.prod.yml start web image-watcher
```

- To regenerate everything in production, stop `image-watcher`, run the regeneration, and start it again:

```bash
docker compose -f docker-compose.prod.yml stop image-watcher
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher npx tsx scripts/imageWatcher.ts --once --force
docker compose -f docker-compose.prod.yml start image-watcher
```

- If this folder is deleted, the watcher exits 1, and neither container can start until the folder is back. Stop the stack, copy the folder back into place rather than moving it with `mv`, then start the stack.

## Deployment

When using Docker, this directory should be bind-mounted from the host. `docker-compose.prod.yml` mounts it so that Compose never creates it when it's missing:

```yaml
volumes:
  - type: bind
    source: ./public/assets/photos
    target: /app/public/assets/photos
    bind:
      create_host_path: false
```

This allows photos to be added/updated without rebuilding the container.

## Git Tracking

Photos in this directory are typically excluded from git (via .gitignore) since:
- Photo files can be very large
- They're managed separately from code
- In production, they're mounted from the host filesystem