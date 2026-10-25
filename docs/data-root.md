# The data root

The data root is `./portfolio-data` next to `docker-compose.prod.yml` on the host. It holds what the site knows about each photo beyond the file itself: a stable photo ID, every revision of the file's bytes, and the `/media` sets built from each revision. Both containers mount it at `/data/portfolio`, which `PHOTOGRAPHY_DATA_DIR` names. Only the watcher and `photos.mjs` write it, and `web` mounts it read-only.

The registry in it names every photo by its path in the library and by the SHA-256 of its bytes, so the library and the data root only make sense together. Back them up together and restore them together.

## Layout

| Path | What it holds | Written by |
|---|---|---|
| `data-root.json` | The marker that says the folder is an initialized data root | `migrate --apply`, once |
| `identity/registry/v<N>.json` | Every photo ID, the photo's path, and its revisions, with the state of each revision's `/media` set. A [version folder](#version-folders): the highest `v<N>.json` is the registry. | The watcher, `migrate --apply`, and `identity` decisions |
| `authored/site/v<N>.json`, `authored/<kind>/<id>/v<N>.json` | The authored catalog records: the site record, and one version folder per series (`authored/series/<seriesId>/`) and per photo (`authored/photos/<photoId>/`) | Nothing yet. The catalog commands of #13 will. |
| `identity/stat-cache.json` | File sizes and times, so a pass doesn't hash files that haven't changed. Safe to delete, though the next pass then reads every photo again, as [Health](#health) says. | The watcher |
| `identity/decisions/` | `identity` decisions waiting for a pass, then filed under `applied/` or `rejected/` | `photos.mjs identity` |
| `identity/migration/` | Dry-run plans and reports, and the mapping each apply wrote from paths and legacy URLs to photo IDs | `photos.mjs migrate` |
| `assets/<photoId>/<assetRevision>/<profileId>/` | One `/media` set: its WebP and AVIF files and `manifest.json`. A set never changes once it's written. | The watcher |
| `staging/` | Sets still being built | The watcher |
| `status/watcher.json` | The watcher's heartbeat, which its healthcheck reads | The watcher, every 30 s |
| `locks/` | The locks writers take on the registry and the authored records | The watcher and `photos.mjs` |

Everything in it belongs to uid 1001, the user both containers run as, and only that user can read it, since the registry keeps curator-only details such as GPS. To read a file, go through the container instead of `sudo`:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher cat /data/portfolio/<path>
```

## Version folders

Every document that two writers could change at once is a folder with one file per version: `identity/registry/`, `authored/site/`, `authored/series/<seriesId>/`, and `authored/photos/<photoId>/`. Inside each folder the versions are `v1.json`, `v2.json`, and so on. The highest number is the document. A write never changes an existing file. It adds the next number with `link()`, which fails if that number already exists, so two writers can't both store the same version. That's why the data root needs a filesystem with hard links.

Each write keeps the two newest versions and removes older ones. Files that start with `.v` and end in `.tmp` are writes in progress, or left by a write that crashed. The next write in that folder removes them. Leave them alone.

Every version carries a `stamp` with its own number and a hash of its content. That's how a command notices a file that was edited in place.

## Editing a document by hand

Only while no command runs: stop the watcher, and don't run `photos.mjs` commands until you're done. Edit as uid 1001, from a shell in the watcher's image, so the new version keeps the owner and mode the containers need:

1. Stop the watcher and open a shell:

   ```bash
   docker compose -f docker-compose.prod.yml stop image-watcher
   docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher sh
   ```

2. Copy the newest version to the next number. `cp -n` refuses to overwrite, so a typo can't replace a version:

   ```bash
   cd /data/portfolio/authored/photos/<photoId>
   ls                          # say v3.json and v4.json
   cp -n v4.json v5.json
   ```

3. Edit `v5.json`, with `vi v5.json` in that shell. Leave its `stamp` as it is. A stamp that names another number marks the file as made by hand, and the next write stamps the version after it again.
4. Leave the shell with `exit`, and start the watcher again:

   ```bash
   docker compose -f docker-compose.prod.yml start image-watcher
   ```

Never edit a version in place. A command that reads an edited newest version refuses it: `photos.mjs identity status` reports the registry as unreadable and exits 1, the catalog lists the record as edited in place, and nothing writes on top of it. The message names the copy that recovers it (`cp -n v4.json v5.json`). Run that to keep the edit as a new version, or restore the file from a backup.

An edit that also changes or removes the stamp isn't caught. It reads as a version made by hand.

## Where it can live

- On a local POSIX filesystem on the same host as the containers, such as ext4 or XFS. The writers depend on atomic renames, hard links, `O_EXCL` lock files, and `fsync`, which NFS, SMB, and synced folders like Dropbox don't guarantee, and exFAT and FAT have no hard links at all. The watcher also refuses to build sets when `assets/` and `staging/` sit on different filesystems.
- Outside `public/` and the photo library. The containers treat a data root inside either one as `unavailable`, since anything under `public/` can end up served.
- In a folder that already exists. `docker-compose.prod.yml` never creates `./portfolio-data`, so if it goes missing, neither container starts. Compose won't quietly start over with an empty one.

## Setting it up

Before the first `up -d` with this compose file:

```bash
mkdir -p portfolio-data
sudo chown -R 1001:1001 public/assets/photos portfolio-data
sudo chmod 700 portfolio-data
```

Until the migration below initializes it, the watcher writes only its heartbeat there, logs once that the identity step is off, and keeps writing the legacy derivatives the site serves today. `GET /api/health` reports `uninitialized`.

## Never migrate into an empty data root beside a library that had IDs

`migrate --apply` gives a new photo ID to every photo the registry doesn't know. If a library already had a data root, migrating it again into an empty one gives every photo a new ID, and every link and catalog entry that names an old ID stops resolving. Afterwards, nothing tells the new IDs apart from a first migration's.

If `./portfolio-data` is lost or comes up empty on a host whose library had IDs, stop the watcher and restore the data root from a backup, as [Restoring](#restoring) describes. Run the migration only on a library that never had a data root.

## Backing up

While the stack runs, the watcher is the only process that writes the data root, and it writes the legacy derivatives in the library too. Stop it, archive both folders together, and start it again:

```bash
docker compose -f docker-compose.prod.yml stop image-watcher
sudo sh -c 'umask 077 && tar -czf photography-$(date -u +%Y%m%dT%H%M%SZ).tar.gz public/assets/photos portfolio-data'
docker compose -f docker-compose.prod.yml start image-watcher
```

`sudo` lets `tar` read the uid 1001 files, and `umask 077` makes the archive readable by root only, since it holds the registry and its curator-only details. Keep archives in a folder only you can read, such as one made with `mkdir -m 700`, and copy them off the host the same way. `web` keeps serving meanwhile, since it only reads, but don't run `photos.mjs` commands while `tar` runs. `./.next-images-cache` needs no backup.

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

If only the data root was lost and the library is fine, restore just `portfolio-data` from the newest archive and keep the current library. Move whatever is left of `./portfolio-data` aside first, as above. `tar` overwrites only the files the archive has and keeps the rest, so files written after the archive would otherwise stay beside the restored ones. A newer decision would apply to the older state, and a newer registry version, with the highest number in `identity/registry/`, would still be the registry:

```bash
docker compose -f docker-compose.prod.yml stop
sudo mv portfolio-data portfolio-data.before-restore
sudo tar -xzpf photography-<timestamp>.tar.gz portfolio-data
docker compose -f docker-compose.prod.yml up -d
```

The watcher's next pass keeps the ID of every photo that archive knew, follows a photo renamed since by its bytes, marks one deleted since as missing, and gives new IDs only to photos added after the archive was made. That loses far less than migrating again.

## Health

`GET /api/health` answers 200 whenever `web` is up, with the data root's state: `ready`, `uninitialized`, `unavailable`, or `unset`. Both `web` healthchecks call it.

The watcher's healthcheck runs `node dist/scripts/watcherHealth.mjs`, which passes while `status/watcher.json` is at most 120 s old, isn't stamped more than 120 s ahead of the container's clock, and shows no identity pass running longer than 30 minutes. The watcher rewrites it every 30 s, so a watcher whose loop stopped, a data root uid 1001 can't write, or an identity pass that never ends turns it unhealthy. It doesn't catch a legacy derivative job that never finishes: a pass starts only once the legacy step is idle, and the legacy backlog on a first start can rightly take hours, so the healthcheck doesn't time it. The 30-minute limit can also flag a pass that's working as it should. A pass reads, hashes, and decodes every file whose size, inode, or times changed, so after a restore, after `identity/stat-cache.json` is deleted, or after a `chown -R` of the library, the first pass reads every photo again, and on a large library that can take longer than 30 minutes. The watcher shows unhealthy until that pass ends, so check its logs before acting on it. If `/media` sets stop appearing while the watcher reads healthy, check its logs for the last photo it processed. `restart: always` doesn't act on unhealthy, so this only changes what `ps` and a dashboard show. `docker compose -f docker-compose.prod.yml ps` shows the state, and the healthcheck's last lines say why:

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
