# Photos Directory

This directory is where gallery photos should be placed.

## Usage

1. Add your photos (JPG, JPEG, PNG, WEBP) to this directory
2. The gallery will automatically load them via the `/api/photos` endpoint
3. Photos are sorted by date taken (newest first), extracted from EXIF metadata

## Replacing and Removing Photos

- Saving over a photo under the same name regenerates its derivatives. The old ones keep serving until all seven new ones are written.
- Deleting a photo hides it from the gallery, but its derivative files stay reachable at their URLs until `images:cleanup` deletes them. Restoring the file brings it back in the gallery after `web` restarts, since Next serves only the `public/` files that existed when it started.
- `npm run images:cleanup` lists derivatives no photo needs anymore, with the reason for each, and prints a plan hash. It deletes them only when re-run with `-- --apply --plan <hash>`. In production:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher npx tsx scripts/imageCleanup.ts
```

- To take a photo down, delete it, run `images:cleanup` with `--only <name>` and then `--only <name> --apply --plan <hash>`, then stop `web`, run `rm -rf ./.next-images-cache/*`, and start `web`.
- To regenerate everything in production, stop `image-watcher`, then run:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher npx tsx scripts/imageWatcher.ts --once --force
```

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