# The data root

The data root is `./portfolio-data` next to `docker-compose.prod.yml` on the host. It holds what the site knows about each photo beyond the file itself: a stable photo ID, every revision of the file's bytes, and the `/media` sets built from each revision. Both containers mount it at `/data/portfolio`, which `PHOTOGRAPHY_DATA_DIR` names. Only the watcher and `photos.mjs` write it, and `web` mounts it read-only.

The registry in it names every photo by its path in the library and by the SHA-256 of its bytes, so the library and the data root only make sense together. Back them up together and restore them together.

## Layout

| Path | What it holds | Written by |
|---|---|---|
| `data-root.json` | The marker that says the folder is an initialized data root | `migrate --apply`, once |
| `identity/registry.json` | Every photo ID, the photo's path, and its revisions, with the state of each revision's `/media` set | The watcher, `migrate --apply`, and `identity` decisions |
| `identity/stat-cache.json` | File sizes and times, so a pass doesn't hash files that haven't changed. Safe to delete. | The watcher |
| `identity/decisions/` | `identity` decisions waiting for a pass, then filed under `applied/` or `rejected/` | `photos.mjs identity` |
| `identity/migration/` | Dry-run plans and reports, and the mapping each apply wrote from paths and legacy URLs to photo IDs | `photos.mjs migrate` |
| `assets/<photoId>/<assetRevision>/<profileId>/` | One `/media` set: its WebP and AVIF files and `manifest.json`. A set never changes once it's written. | The watcher |
| `staging/` | Sets still being built | The watcher |
| `status/watcher.json` | The watcher's heartbeat, which its healthcheck reads | The watcher, every 30 s |
| `locks/` | The lock every writer takes on the registry | The watcher and `photos.mjs` |

Everything in it belongs to uid 1001, the user both containers run as, and only that user can read it, since the registry keeps curator-only details such as GPS. To read a file, go through the container instead of `sudo`:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher cat /data/portfolio/<path>
```

## Where it can live

- On a local POSIX filesystem on the same host as the containers, such as ext4 or XFS. The writers depend on atomic renames, `O_EXCL` lock files, and `fsync`, which NFS, SMB, and synced folders like Dropbox don't guarantee. The watcher also refuses to build sets when `assets/` and `staging/` sit on different filesystems.
- Outside `public/` and the photo library. The containers treat a data root inside either one as `unavailable`, since anything under `public/` can end up served.
- In a folder that already exists. `docker-compose.prod.yml` never creates `./portfolio-data`, so if it goes missing, neither container starts. Compose won't quietly start over with an empty one.

## Setting it up

Before the first `up -d` with this compose file:

```bash
mkdir -p portfolio-data
sudo chown -R 1001:1001 public/assets/photos portfolio-data
```

Until the migration below initializes it, the watcher writes only its heartbeat there, logs once that the identity step is off, and keeps writing the legacy derivatives the site serves today. `GET /api/health` reports `uninitialized`.

## Never migrate into an empty data root beside a library that had IDs

`migrate --apply` gives a new photo ID to every photo the registry doesn't know. If a library already had a data root, migrating it again into an empty one gives every photo a new ID, and every link and catalog entry that names an old ID stops resolving. Afterwards, nothing tells the new IDs apart from a first migration's.

If `./portfolio-data` is lost or comes up empty on a host whose library had IDs, stop the watcher and restore the data root from a backup, as [Restoring](#restoring) describes. Run the migration only on a library that never had a data root.

## Backing up

While the stack runs, the watcher is the only process that writes the data root, and it writes the legacy derivatives in the library too. Stop it, archive both folders together, and start it again:

```bash
docker compose -f docker-compose.prod.yml stop image-watcher
sudo tar -czf photography-$(date -u +%Y%m%dT%H%M%SZ).tar.gz public/assets/photos portfolio-data
docker compose -f docker-compose.prod.yml start image-watcher
```

`sudo` lets `tar` read the uid 1001 files. `web` keeps serving meanwhile, since it only reads, but don't run `photos.mjs` commands while `tar` runs. `./.next-images-cache` needs no backup.

## Restoring

Restore both folders from the same archive, so the registry describes the library beside it. Move the current folders aside instead of deleting them until the restored stack checks out. Extracting as root with `-p` keeps the files' owners and modes:

```bash
docker compose -f docker-compose.prod.yml stop
sudo mv public/assets/photos photos.before-restore
sudo mv portfolio-data portfolio-data.before-restore
sudo tar -xzpf photography-<timestamp>.tar.gz
docker compose -f docker-compose.prod.yml up -d
```

Then check that `photos.mjs identity status` counts the photos you expect, as in step 6 of the runbook, and that `GET /api/health` reports `ready`.

If only the data root was lost and the library is fine, restore just `portfolio-data` from the newest archive and keep the current library. Move whatever is left of `./portfolio-data` aside first, as above:

```bash
docker compose -f docker-compose.prod.yml stop
sudo tar -xzpf photography-<timestamp>.tar.gz portfolio-data
docker compose -f docker-compose.prod.yml up -d
```

The watcher's next pass keeps the ID of every photo that archive knew, follows a photo renamed since by its bytes, marks one deleted since as missing, and gives new IDs only to photos added after the archive was made. That loses far less than migrating again.

## Health

`GET /api/health` answers 200 whenever `web` is up, with the data root's state: `ready`, `uninitialized`, `unavailable`, or `unset`. Both `web` healthchecks call it.

The watcher's healthcheck runs `node dist/scripts/watcherHealth.mjs`, which passes while `status/watcher.json` is at most 120 s old, isn't stamped more than 120 s ahead of the container's clock, and shows no identity pass running longer than 30 minutes. The watcher rewrites it every 30 s, so a watcher whose loop stopped, a data root uid 1001 can't write, or an identity pass that never ends turns it unhealthy. It doesn't catch a legacy derivative job that never finishes: a pass starts only once the legacy step is idle, and the legacy backlog on a first start can rightly take hours, so the healthcheck doesn't time it. If `/media` sets stop appearing while the watcher reads healthy, check its logs for the last photo it processed. `restart: always` doesn't act on unhealthy, so this only changes what `ps` and a dashboard show. `docker compose -f docker-compose.prod.yml ps` shows the state, and the healthcheck's last lines say why:

```bash
docker inspect --format '{{json .State.Health}}' "$(docker compose -f docker-compose.prod.yml ps -q image-watcher)"
```

## Migration runbook

Run this once, on a library that never had a data root, to give every photo its ID. Nothing on the site uses the IDs yet, and the legacy derivatives keep serving throughout.

1. Stop the watcher, so the library holds still:

   ```bash
   docker compose -f docker-compose.prod.yml stop image-watcher
   ```

2. Back up both folders, as [Backing up](#backing-up) describes. The watcher is already stopped, so skip its `stop` and `start`.

3. Dry-run the migration in `image-watcher`. It proposes an ID for every photo, writes only a plan and a report to `identity/migration/`, and prints both paths. Then read the report:

   ```bash
   docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs migrate --dry-run
   docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher cat <report path>
   ```

   Check its duplicate-byte groups, basename collisions, unreadable, unsupported, and undecodable files, and ambiguous items. An ambiguous file gets no ID until you decide with `photos.mjs identity bind` or `new`.

4. Apply the plan the dry run printed. It writes the registry with exactly the plan's IDs, and `data-root.json`, after which `GET /api/health` reports `ready`. If the library or the registry changed since the dry run, it refuses, so run the dry run again and apply that plan. Applying a plan twice prints that it's already applied and exits 0.

   ```bash
   docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs migrate --apply --plan <plan path>
   ```

5. Start the watcher. `--apply` builds no derivatives. The watcher builds every photo's `/media` set:

   ```bash
   docker compose -f docker-compose.prod.yml start image-watcher
   ```

6. Check progress the same way, every minute or so, until it says `Pending jobs: 0`:

   ```bash
   docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs identity status
   ```

   `Failed profiles` should be 0, and `Watcher heartbeat` under 120 s. An entry with `source-superseded` is fine. It means the photo's file changed after that revision was recorded, and the watcher builds the newer revision instead. For any other failure, fix the cause, then run `node dist/scripts/photos.mjs identity retry <photoId>` the same way.
