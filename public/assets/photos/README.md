# Photos Directory

This directory is the photo library: the originals the site's photos are made from. Nothing in the stack writes it.

## Usage

1. Add your photos (JPG, JPEG, PNG, WEBP) to this directory, in any folder.
2. Once `photos:migrate --apply` has initialized the data root, the watcher gives each photo its ID and builds its `/media` set there, and the curator's Inbox shows it. A photo reaches the site only through a publish that places it in a series: visitors see only the `/media` sets the active catalog revision holds.
3. Nothing in this folder is served. `/assets/photos` answers 404 for the originals and for any legacy derivatives still here, and `/_next/image` refuses them with 400. Check the site with `/api/ready`, which names the revision being served.

## The mount at `/data/library`

Since v1.7.0 (#13's slice E), `docker-compose.prod.yml` mounts this folder, `./public/assets/photos` on the host, at `/data/library` inside the containers, read-only, and sets `PHOTOGRAPHY_LIBRARY_DIR=/data/library`:

```yaml
volumes:
  - type: bind
    source: ./public/assets/photos
    target: /data/library
    read_only: true
    bind:
      create_host_path: false
```

- `image-watcher` mounts it, and so does every command run in it with `docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs <command>`. They read it and write only the data root.
- `curator` doesn't mount it. It reads no file here, and sets `PHOTOGRAPHY_LIBRARY_DIR` only to keep the path out of its messages.
- `web` doesn't mount it at all. It reads nothing here.
- `create_host_path: false` means a missing folder keeps `image-watcher` from starting, instead of showing it an empty library. If the folder is there but empty, as a network share not mounted yet can be, a pass that finds no photo while the registry has photos present marks nothing missing, logs why, turns the watcher unhealthy, and tries again a minute later.
- `PHOTOGRAPHY_LIBRARY_DIR` has no default. Unset, relative, or at or inside the app's `public/` folder, the watcher and every command that reads the library exit 1 and name it, rather than read another folder. Before v1.7.0 the containers took `/app/public/assets/photos` by default, and a v1.7.0 image run with an older compose file stops there instead of reading that path.
- uid 1001, which both containers run as, only needs to read the photos: every folder at least `0755` and every photo at least `0644`. [docs/data-root.md](../../../docs/data-root.md#who-owns-the-photos) has a command that lists anything it can't read. A file sync tool running as another user can keep owning them.
- With an override that binds the photos from somewhere else, bind it at `/data/library` too. Compose merges `volumes:` by target, so an override bind at the old `/app/public/assets/photos` adds a second mount, which no service reads, and the base file's bind stays at `/data/library`. [releasing.md's v1.7.0 steps](../../../docs/releasing.md#v170-the-library-at-datalibrary) check this before the switch.

This lets you add or update photos without rebuilding the container.

Both containers also mount `./portfolio-data`, the private data root, which holds each photo's stable ID and its `/media` sets. Its registry names every photo by its path in this folder, relative to it, so back the two up together and restore them together. [docs/data-root.md](../../../docs/data-root.md) covers setting it up, ownership, backups, restores, and the one-time migration.

## Replacing and Removing Photos

- Saving over a photo under the same name gives it a new version: the watcher builds a new `/media` set, and the Inbox opens a replacement item for it. The site serves none of the files here: `/assets/photos` answers 404 and `/_next/image` refuses it.
- Deleting a photo hides nothing: the active catalog revision keeps listing the photo, and `/media` keeps serving it. A takedown is the archive and publish below.
- A takedown is archive, then publish, run as `node dist/scripts/photos.mjs <command>` in `image-watcher`, as above. Deleting, moving, or renaming a file here takes nothing down: the active revision keeps listing the photo, `/media` keeps serving it, and the watcher opens a `missing` item in the curation inbox, which closes if the same file comes back. To take the photo down, move its file out of this folder and run `curation archive` on its `missing` item, which takes it out of every series in the draft. A publish then needs a new cover where it was the cover (`sequence cover`), and a chapter it alone made up removed first (`sequence chapter remove`), or archive refuses. The remove clears it as the opening photograph, so the series has none until `sequence opening` picks another. Where it was a series' only photograph, hide the series (set `visibility` to `"hidden"` on a host copy and save it with `edit <seriesId> --file <path> --expect-version <N>`, as the root README's "Curating the catalog" shows), and take a hidden series out of the featured list with `series featured <seriesId>...`, keeping at least one published. Run `validate`, check that `publish --dry-run --actor <name>` lists the photo under `Removed`, then publish. Check that `GET /api/ready` answers `"state":"ok"` with the new `revisionId`: `degraded` means `web` still serves the revision before. Purge the photo's `/media` URLs from any CDN, since `/media` sends `max-age=31536000, immutable` and a browser can keep the photo for up to a year. Archive deletes nothing. If the publish stops on errors in other records, the photo stays public. As a last resort, delete `assets/<photoId>/` in the data root inside `image-watcher`, so `/media` 404s it until a publish leaves it out. The project README's "Take a photo down" has the steps.
- If this folder is deleted, the watcher exits 1, and `image-watcher` can't start until the folder is back. Stop the stack, copy the folder back into place rather than moving it with `mv`, then start the stack.

## Legacy derivatives from before v1.7.0

A watcher before v1.7.0 wrote seven resized copies of each photo in this folder's top level, in `thumbnails/`, `medium/`, `optimized/`, `thumbnails-avif/`, `medium-avif/`, `optimized-avif/` and `lqip/`, and kept `cache/` beside them. From v1.7.0 nothing writes, reads, or serves them, and the watcher leaves them exactly as they are. The identity scan still skips those eight names at the top level, so nothing in them is ever taken for a photo. They take space and nothing else, so leave them in place: #15's GC reclaims them once it ships, and until then a rollback to v1.6.x finds them where its watcher left them. No documented step moves or deletes anything in this folder.

## Git Tracking

Photos in this directory are typically excluded from git (via .gitignore) since:
- Photo files can be very large
- They're managed separately from code
- In production, they're mounted from the host filesystem

The build leaves this folder's photos out of the image. Only this README and `.gitkeep` go in.
