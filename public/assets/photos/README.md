# Photos Directory

This directory is where gallery photos should be placed.

## Usage

1. Add your photos (JPG, JPEG, PNG, WEBP) to this directory
2. The gallery will automatically load them via the `/api/photos` endpoint
3. Photos are sorted by date taken (newest first), extracted from EXIF metadata

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