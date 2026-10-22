# Photos Directory

This directory is where gallery photos should be placed.

## Usage

1. Add your photos (JPG, JPEG, PNG, WEBP) to this directory
2. The gallery loads them through `/api/photos` once the watcher has recorded them in the data root and written all seven of their derivatives. Until `photos:migrate --apply` has initialized the data root, `/api/photos` answers 503 and the gallery is empty. The original files are never served.
3. Photos are sorted by date taken (newest first), extracted from EXIF metadata

## Replacing and Removing Photos

- Saving over a photo under the same name regenerates its derivatives. The old ones keep serving until all seven new ones are written. `/_next/image` can serve the old version for up to a day, and a browser that cached it under the old `immutable` header may keep it for up to a year.
- Accepted risk: a different photo saved under a removed photo's name, with an older modification time, shows the old images until you `touch` it or run `--force`. Copy tools that keep modification times, such as `cp -p` and `rsync -a`, do this.
- Deleting a photo hides it from the gallery once the watcher's next pass records it missing. Nothing deletes its derivative files, which stay reachable at their URLs, so restoring the file brings it back with nothing to rebuild.
- To take a photo down:
  1. Stop `image-watcher`, so a job already running can't write its derivatives back, then delete the photo.
  2. Delete its seven derivatives and `cache/set-sources/<name>.json`, where `<name>` is the photo's file name without its extension, such as `landscape`. Do the same for each earlier name the photo had.
  3. Purge Next's image cache inside the `web` image, since its files belong to the containers' user, then start the stack.
  4. Check that `/api/photos` no longer lists the photo. Once a catalog revision is active, it keeps serving the photo from `/media` until a publish leaves it out.

```bash
docker compose -f docker-compose.prod.yml stop image-watcher
# Delete the photo, then, with its name for <name>:
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher sh -c 'cd /app/public/assets/photos && rm -f -- thumbnails/"$1".webp medium/"$1".webp optimized/"$1".webp thumbnails-avif/"$1".avif medium-avif/"$1".avif optimized-avif/"$1".avif lqip/"$1".txt cache/set-sources/"$1".json' sh '<name>'
docker compose -f docker-compose.prod.yml stop web
docker compose -f docker-compose.prod.yml run --rm --no-deps web sh -c 'rm -rf /app/.next/cache/images/*'
docker compose -f docker-compose.prod.yml start web image-watcher
```

- To regenerate everything in production, stop `image-watcher`, run the regeneration, and start it again:

```bash
docker compose -f docker-compose.prod.yml stop image-watcher
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/imageWatcher.mjs --once --force
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

Both containers also mount `./portfolio-data`, the private data root, which holds each photo's stable ID and its `/media` sets. Its registry names every photo by its path in this folder, so back the two up together and restore them together. [docs/data-root.md](../../../docs/data-root.md) covers setting it up, the `chown` both folders need, backups, restores, and the one-time migration.

The build leaves this folder's photos out of the image. Only this README and `.gitkeep` go in.

## Git Tracking

Photos in this directory are typically excluded from git (via .gitignore) since:
- Photo files can be very large
- They're managed separately from code
- In production, they're mounted from the host filesystem