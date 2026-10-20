# Photos Directory

This directory is where gallery photos should be placed.

## Usage

1. Add your photos (JPG, JPEG, PNG, WEBP) to this directory
2. The gallery will automatically load them via the `/api/photos` endpoint
3. Photos are sorted by date taken (newest first), extracted from EXIF metadata

## Replacing and Removing Photos

- Saving over a photo under the same name regenerates its derivatives. The old ones keep serving until all seven new ones are written, and the gallery shows the original meanwhile. `/_next/image` can serve the old version for up to a day, and a browser that cached it under the old `immutable` header may keep it for up to a year. If you copy a replacement in while the watcher is stopped and the copy keeps an older modification time, as `cp -p` does, `touch` it so the next start picks it up.
- Deleting a photo hides it from the gallery, but its derivative files stay reachable at their URLs until `images:cleanup` deletes them. Restoring the file brings it back in the gallery after `web` restarts, since Next serves only the `public/` files that existed when it started.
- `npm run images:cleanup` lists derivatives no photo needs anymore, with the reason for each, and prints a plan hash. It deletes them only when re-run with `-- --apply --plan <hash>`. In production:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher npx tsx scripts/imageCleanup.ts
```

- To take a photo down, stop `image-watcher` first, so a job already running can't write its derivatives back. `<name>` is the photo's exact name, such as `landscape`. The cache purge runs inside the `web` image, since the cache files belong to its uid 1001:

```bash
docker compose -f docker-compose.prod.yml stop image-watcher
# Delete the photo, then:
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

- If this folder is deleted or moved, the watcher exits 1. Once it's back, run `docker compose -f docker-compose.prod.yml restart web image-watcher`, since each container keeps the old folder mounted until it restarts.

## Deployment

When using Docker, this directory should be bind-mounted from the host:

```yaml
# docker-compose.yml
volumes:
  - ./public/assets/photos:/app/public/assets/photos
```

This allows photos to be added/updated without rebuilding the container.

## Git Tracking

Photos in this directory are typically excluded from git (via .gitignore) since:
- Photo files can be very large
- They're managed separately from code
- In production, they're mounted from the host filesystem