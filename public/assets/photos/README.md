# Photos Directory

This directory is where gallery photos should be placed.

## Usage

1. Add your photos (JPG, JPEG, PNG, WEBP) to this directory
2. The gallery will automatically load them via the `/api/photos` endpoint
3. Photos are sorted by date taken (newest first), extracted from EXIF metadata

## Replacing and Removing Photos

- Saving over a photo under the same name regenerates its derivatives. The old ones keep serving until all seven new ones are written.
- Deleting a photo hides it from `/api/photos` but keeps its derivatives, so restoring the file brings it back.
- `npm run images:cleanup` lists derivatives no photo needs anymore, with the reason for each, and deletes them only with `-- --apply`. In production:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher npx tsx scripts/imageCleanup.ts
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