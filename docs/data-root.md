# The data root

The data root is `./portfolio-data` next to `docker-compose.prod.yml` on the host. It holds what the site knows about each photo beyond the file itself: a stable photo ID, every revision of the file's bytes, and the `/media` sets built from each revision. Both containers mount it at `/data/portfolio`, which `PHOTOGRAPHY_DATA_DIR` names. Only the watcher and `photos.mjs` write it, and `web` mounts it read-only.

The registry in it names every photo by its path in the library and by the SHA-256 of its bytes, so the library and the data root only make sense together. Back them up together and restore them together.

## Layout

| Path | What it holds | Written by |
|---|---|---|
| `data-root.json` | The marker that says the folder is an initialized data root | `migrate --apply`, once |
| `identity/registry/v<N>.json` | Every photo ID, the photo's path, and its revisions, with the state of each revision's `/media` set. A [version folder](#version-folders): the highest `v<N>.json` is the registry. | The watcher, `migrate --apply`, and `identity` decisions |
| `authored/site/v<N>.json`, `authored/<kind>/<id>/v<N>.json` | The authored catalog records: the site record, and one version folder per series (`authored/series/<seriesId>/`) and per photo (`authored/photos/<photoId>/`) | `photos.mjs` `draft:init`, `describe`, `sequence`, `series`, and `edit`, a hand-made copy at the next version as [Editing a document by hand](#editing-a-document-by-hand) describes, and `photos.mjs publish` and `rollback` when they rebase them |
| `identity/stat-cache.json` | File sizes and times, so a pass doesn't hash files that haven't changed. Safe to delete, though the next pass then reads every photo again, as [Health](#health) says. | The watcher |
| `identity/decisions/` | `identity` decisions waiting for a pass, then filed under `applied/` or `rejected/` | `photos.mjs identity` |
| `identity/migration/` | Dry-run plans and reports, and the mapping each apply wrote from paths and legacy URLs to photo IDs | `photos.mjs migrate` |
| `assets/<photoId>/<assetRevision>/<profileId>/` | One `/media` set: its WebP and AVIF files and `manifest.json`. A set never changes once it's written. | The watcher |
| `staging/` | Sets still being built | The watcher |
| `status/watcher.json` | The watcher's heartbeat, which its healthcheck reads | The watcher, every 30 s |
| `catalog/revisions/` | Every published revision, which never changes once it's written | `photos.mjs publish` |
| `catalog/activations/` | Each activation: every publish and rollback adds one | `photos.mjs publish` and `rollback` |
| `catalog/active/v<N>.json` | The pointer to the active revision. A [version folder](#version-folders), so a publish or a rollback moves it by adding the next version. | `photos.mjs publish` and `rollback` |
| `catalog/candidates/`, `catalog/diagnostics/` | The last compile of each candidate, its issues, and how the last publish ended | `photos.mjs publish` |
| `locks/` | The locks writers take on the registry, the authored records, the catalog, and the curation inbox | The watcher and `photos.mjs` |
| `edits/` | `photos.mjs edit`'s working copies, and edits it kept because they couldn't be saved, which `edit <id> --file <path> --expect-version <N>` saves once fixed. Private, like the rest (0700, files 0600). Nothing reads them as records, and `references()` doesn't list them, so the cleanup #15 adds has to leave the folder alone. Delete a kept edit once it's saved or no longer wanted. | `photos.mjs edit` |
| `curation/events/<eventId>/v<N>.json` | One [curation inbox](#curation-inbox) item. A [version folder](#version-folders). | The watcher, and `photos.mjs curation` |
| `curation/rules.json` | Your series suggestion rules for the inbox, if you want any | You |

Everything in it belongs to uid 1001, the user both containers run as, and only that user can read it, since the registry keeps curator-only details such as GPS. To read a file, go through the container instead of `sudo`:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher cat /data/portfolio/<path>
```

## Version folders

Every document that two writers could change at once is a folder with one file per version: `identity/registry/`, `authored/site/`, `authored/series/<seriesId>/`, `authored/photos/<photoId>/`, each curation inbox item's `curation/events/<eventId>/`, and the active catalog pointer, `catalog/active/`. Inside each folder the versions are `v1.json`, `v2.json`, and so on. The highest number is the document. A write never changes an existing file. It adds the next number with `link()`, which fails if that number already exists, so two writers can't both store the same version. That's why the data root needs a filesystem with hard links.

Never edit the active pointer by hand: only `photos.mjs publish` and `photos.mjs rollback` move it. A version copied there by hand makes a revision live without the checks a publish runs, so the next command refuses to record it if the rules block that revision.

Each write keeps the two newest versions and removes older ones. Files that start with `.v` and end in `.tmp` are writes in progress, or left by a write that crashed. The next write in that folder removes them. Leave them alone.

A record's folder is a real folder, never a symlink: the catalog refuses a linked one, dangling or not, and says so. The data root itself may be a symlink for the app, but [Backing up](#backing-up) and [Restoring](#restoring) need it to be a real folder.

Every version carries a `stamp` with its own number and a hash of its content. That's how a command notices a file that was edited in place.

An older build stored each of these as one file: `identity/registry.json`, `authored/site.json`, `authored/series/<seriesId>.json`, `authored/photos/<photoId>.json`. This build refuses to read or write a document while its old file is there, and the message names the file. While no command runs (see below), move it into a new folder as `v1.json`. The folder takes the file's owner and group, read from the file itself, so the app can write the next version there.

On the production host, run it from the folder with `docker-compose.prod.yml`, after `PHOTOGRAPHY_DATA_DIR="$PWD/portfolio-data"`. Compose sets the variable only inside the containers, where it's `/data/portfolio`.

```bash
file="$PHOTOGRAPHY_DATA_DIR/authored/photos/<photoId>.json"   # or any old file above
folder="${file%.json}"
uid="$(sudo stat -c %u "$file")" && gid="$(sudo stat -c %g "$file")" &&
  sudo test ! -e "$folder" &&
  sudo install -d -o "$uid" -g "$gid" -m 700 "$folder" &&
  sudo mv -n "$file" "$folder/v1.json"
```

On macOS, use `stat -f %u` and `stat -f %g` in place of `stat -c %u` and `stat -c %g`. Each step runs only if the one before it worked, so nothing runs for a missing file. The `test` stops it when the folder already exists, since `install -d` would change an existing folder's owner. In that case the old file sits beside versions of its own, and nothing says which copy is current: decide that first, by hand.

## Editing a document by hand

This is for the registry and the authored records, never the active pointer.

Only while no command runs: stop the watcher, and don't run `photos.mjs` commands until you're done. The folders are 0700 and the files 0600, owned by the user the app runs as (uid 1001 in the containers), so the new version has to keep that owner and mode. A copy root owns can't be read by the app: the registry then reads as unreadable, and a record as `unreadable`. With the containers, edit as uid 1001 from a shell in the watcher's image:

1. Stop the watcher and open a shell:

   ```bash
   docker compose -f docker-compose.prod.yml stop image-watcher
   docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher sh
   ```

2. Copy the newest version to the next number, and edit the copy. The newest is the highest number, not the last name `ls` prints: `v10.json` sorts before `v9.json`. The `test` and `cp -n` refuse to touch a `v5.json` that already exists, so a typo can't replace a version, and `vi` runs only on a copy just made:

   ```bash
   cd /data/portfolio/authored/photos/<photoId>
   ls                          # say v3.json and v4.json
   test ! -e v5.json && cp -n v4.json v5.json && vi v5.json
   ```

3. While you edit, leave the `stamp` as it is. A stamp that names another number marks the file as made by hand, and the next write stamps the version after it again. Leave `baseRevisionId` alone too, and in the site record `baseSeriesOrder`: publishing manages them, and they're how it tells your edits from the published ones.
4. Leave the shell with `exit`, and start the watcher again:

   ```bash
   docker compose -f docker-compose.prod.yml start image-watcher
   ```

Without the containers, as with the npm scripts' data root, do steps 2 and 3 on the host as root, keeping the owner and mode. `cp -p` keeps the owner and mode of the file it copies, and `sudoedit` writes back into the same file, so the copy keeps both. On the production host, set `PHOTOGRAPHY_DATA_DIR="$PWD/portfolio-data"` first, from the folder with `docker-compose.prod.yml`:

```bash
dir="$PHOTOGRAPHY_DATA_DIR/authored/photos/<photoId>"
sudo ls "$dir"                                    # say v3.json and v4.json
sudo test ! -e "$dir/v5.json" && sudo cp -n -p "$dir/v4.json" "$dir/v5.json" && sudoedit "$dir/v5.json"
```

The `test` and `cp -n` refuse to touch a `v5.json` that already exists, so a typo can't replace a version, and `sudoedit` runs only on a copy just made. `sudoedit` refuses a file in a folder you can write yourself, as when the app runs as your own user, and a path through a symlink in a folder you can write, as when `PHOTOGRAPHY_DATA_DIR` is a link in your home folder. The copy is then still an exact copy of `v4.json`, so nothing is lost: edit `v5.json` as the user who owns it (with your own editor when that's you), or for a link, run `sudoedit` on the resolved path, `sudoedit "$(sudo realpath "$dir/v5.json")"`. If you already copied it with a plain `sudo cp`, give the copy the owner of the version it came from: `owner="$(sudo stat -c %u:%g "$dir/v4.json")" && sudo chown "$owner" "$dir/v5.json"` (`stat -f %u:%g` on macOS).

Never edit a version in place. A command that reads an edited newest version refuses it: `photos.mjs identity status` reports the registry as unreadable and exits 1, the catalog lists the record as edited in place, and nothing writes on top of it. The message names the copy that recovers it (`cp -n v4.json v5.json`). Make that copy as in step 2, in the watcher's shell or with `sudo cp -n -p` on the host, to keep the edit as a new version, or restore the file from a backup.

An edit that also changes or removes the stamp isn't caught. It reads as a version made by hand. An in-place edit of a hand-made copy isn't caught either, since its stamp already names another number. So finish the edit before the watcher starts again. Once the next write stamps a new version, that one is checked again.

## Where it can live

- On a local POSIX filesystem on the same host as the containers, such as ext4 or XFS. The writers depend on atomic renames, hard links, `O_EXCL` lock files, and `fsync`, which NFS, SMB, and synced folders like Dropbox don't guarantee, and exFAT and FAT have no hard links at all. The watcher also refuses to build sets when `assets/` and `staging/` sit on different filesystems.
- Outside `public/` and the photo library. The containers treat a data root inside either one as `unavailable`, since anything under `public/` can end up served.
- In a folder that already exists. `docker-compose.prod.yml` never creates `./portfolio-data`, so if it goes missing, neither container starts. Compose won't quietly start over with an empty one.

## Setting it up

Before the first `up -d` with this compose file, decide who owns the photos. If another process writes them, such as a file sync tool running as another user, don't `chown` them here. Run the block below as it is and follow [Who owns the photos](#who-owns-the-photos) for the photos folder:

```bash
mkdir -p portfolio-data .next-images-cache
sudo chown -R 1001:1001 portfolio-data .next-images-cache
sudo chmod 700 portfolio-data
```

On a host where nothing else writes the photos, also hand the whole folder to uid 1001:

```bash
sudo chown -R 1001:1001 public/assets/photos
```

`./.next-images-cache` is where `web` keeps the `/_next/image` copies it makes, so it has to belong to uid 1001 too. `docker-compose.prod.yml` never creates it, like the other two folders: a short-syntax bind of a missing folder has the Docker daemon create it, owned by root when the daemon runs as root, and `web` then can't write it. A host that ran the older compose file may already have one that Docker created that way, and the `chown` fixes it.

Until the migration below initializes the data root, the watcher writes only its heartbeat there, logs once that the identity step is off, and keeps writing the legacy derivatives. `GET /api/health` reports `uninitialized`. The site lists photos from the registry the migration writes, so until it runs, `/api/photos` and `GET /api/ready` answer 503 with `registry-missing`, and Home and Gallery show no photos.

### Who owns the photos

Both containers run as uid 1001, and each needs only part of the photos folder:

| Container | Reads | Writes |
|---|---|---|
| `web` | The derivatives it serves and the `lqip` files. Each photo's size and EXIF come from the registry in the data root, so it never opens an original. | Only `./.next-images-cache`, outside the photos folder |
| `image-watcher` | The originals, in every folder of the library | The derivative folders (`thumbnails`, `medium`, `optimized`, `thumbnails-avif`, `medium-avif`, `optimized-avif`, `lqip`) and `cache/`, all at the top of the photos folder, and the data root |

When nothing else writes the photos, the second `chown -R` in [Setting it up](#setting-it-up) is the simple way to give uid 1001 all of that.

When another process writes them, such as a file sync tool running as another user, a `chown -R` takes the originals away from it. The tool may then fail to update them, or hand them back to its own user on its next pass, and every change of owner makes the watcher's next identity pass read every photo again, as [Health](#health) says. Leave the originals with their owner, and hand uid 1001 only the folders the watcher writes, creating any that are missing:

```bash
(
  cd public/assets/photos || exit 1
  sudo mkdir -p thumbnails medium optimized thumbnails-avif medium-avif optimized-avif lqip cache
  sudo chown -R 1001:1001 thumbnails medium optimized thumbnails-avif medium-avif optimized-avif lqip cache
)
```

That works only if uid 1001 can still read the originals: every folder in the library readable and searchable, and every photo readable. The containers share no group with the tool unless you set one up, so in practice that means the world bits, folders at least `0755` and photos at least `0644`, and a tool set to create new files that way. A photo that arrives as `0600` stays out of the Gallery, since the watcher can't read it. This prints every file or folder in the library that uid 1001 can't read, so no output means it can read them all:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher \
  find /app/public/assets/photos \( ! -exec test -r {} \; -o -type d ! -exec test -x {} \; \) -print
```

If the tool can leave folders out, leave out the derivative folders and `cache/` too. The watcher builds them from the originals. A subfolder the tool creates in one, as its own user, is one the watcher can't write into, and the tool would sync the watcher's output back and forth for nothing.

## Never migrate into an empty data root beside a library that had IDs

`migrate --apply` gives a new photo ID to every photo the registry doesn't know. If a library already had a data root, migrating it again into an empty one gives every photo a new ID, and every link and catalog entry that names an old ID stops resolving. Afterwards, nothing tells the new IDs apart from a first migration's.

If `./portfolio-data` is lost or comes up empty on a host whose library had IDs, stop the watcher and restore the data root from a backup, as [Restoring](#restoring) describes. Run the migration only on a library that never had a data root.

## Backing up

While the stack runs, the watcher is the only process that writes the data root, and it writes the legacy derivatives in the library too. Stop it, archive both folders together, and start it again.

Both have to be real folders next to `docker-compose.prod.yml`, not symlinks. `tar` stores a symlink named on its command line as the link itself, not the files behind it, so the archive would hold no registry, and a restore's `mv` would move only the link. This block and the ones in [Restoring](#restoring) check that first, and stop before anything else runs. The `exit` leaves only the block's subshell, not your shell:

```bash
(
  for d in public/assets/photos portfolio-data; do
    [ -d "$d" ] && [ ! -L "$d" ] || { echo "$d must be a real folder, not a symlink. Nothing was archived." >&2; exit 1; }
  done
  mkdir -m 700 -p ~/photography-backups
  docker compose -f docker-compose.prod.yml stop image-watcher
  (umask 077 && sudo tar -czf - public/assets/photos portfolio-data >~/photography-backups/photography-$(date -u +%Y%m%dT%H%M%SZ).tar.gz)
  docker compose -f docker-compose.prod.yml start image-watcher
)
```

`sudo` lets `tar` read the uid 1001 files. Your own shell writes the archive, so it belongs to you, and `umask 077` and the 0700 folder keep it readable by you only, since it holds the registry and its curator-only details. Copy it off the host the same way, into a folder only you can read. If `tar` reports an error, delete that archive and run the block again, since the redirect leaves a partial file behind. `web` keeps serving meanwhile, since it only reads, but don't run `photos.mjs` commands while `tar` runs. `./.next-images-cache` needs no backup.

## Restoring

Restore both folders from the same archive, so the registry describes the library beside it. Move the current folders aside instead of deleting them until the restored stack checks out. The timestamp keeps a second restore from moving them inside an earlier one's. Extracting as root with `-p` keeps the files' owners and modes. The blocks stop and start only `web` and `image-watcher`, so a service an override adds keeps running:

```bash
(
  for d in public/assets/photos portfolio-data; do
    [ ! -L "$d" ] || { echo "$d is a symlink. Nothing was moved or restored." >&2; exit 1; }
  done
  docker compose -f docker-compose.prod.yml stop web image-watcher
  aside=before-restore-$(date -u +%Y%m%dT%H%M%SZ)
  sudo mv public/assets/photos "photos.$aside"
  sudo mv portfolio-data "portfolio-data.$aside"
  sudo tar -xzpf ~/photography-backups/photography-<timestamp>.tar.gz
  docker compose -f docker-compose.prod.yml up -d web image-watcher
)
```

Then check that `photos.mjs identity status` counts the photos you expect, as in step 6 of the runbook, and that `GET /api/health` reports `ready`.

If only the data root was lost and the library is fine, restore just `portfolio-data` from the newest archive and keep the current library. Move whatever is left of `./portfolio-data` aside first, as above. `tar` overwrites only the files the archive has and keeps the rest, so files written after the archive would otherwise stay beside the restored ones. A newer decision would apply to the older state, and a newer registry version, with the highest number in `identity/registry/`, would still be the registry:

```bash
(
  [ ! -L portfolio-data ] || { echo "portfolio-data is a symlink. Nothing was moved or restored." >&2; exit 1; }
  docker compose -f docker-compose.prod.yml stop web image-watcher
  sudo mv portfolio-data "portfolio-data.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  sudo tar -xzpf ~/photography-backups/photography-<timestamp>.tar.gz portfolio-data
  docker compose -f docker-compose.prod.yml up -d web image-watcher
)
```

The watcher's next pass keeps the ID of every photo that archive knew, follows a photo renamed since by its bytes, marks one deleted since as missing, and gives new IDs only to photos added after the archive was made. That loses far less than migrating again.

## Health

`GET /api/health` answers 200 whenever `web` is up, with the data root's state: `ready`, `uninitialized`, `unavailable`, or `unset`. Both `web` healthchecks call it.

`GET /api/ready` says whether `web` can list the photos, and from where: `"mode":"legacy"` lists the registry's photos before the first catalog activation, and `"mode":"catalog"` the active revision's after it, with `revisionId`, `revisionNumber`, and `activatedAt`. It answers 503 with a `reason` when it can't list them, such as `registry-missing` before the migration. `registry-old-layout` means the old one-file `identity/registry.json` is still there; move it into `identity/registry/` as the steps above say. `catalog-unreadable` means `web` can't read `catalog/` well enough to tell whether anything was published, for example when a command run as another user left it unreadable to uid 1001. It serves nothing until `catalog/` reads again, and then goes back to legacy if nothing was published.

The watcher's healthcheck runs `node dist/scripts/watcherHealth.mjs`, which passes while `status/watcher.json` is at most 120 s old, isn't stamped more than 120 s ahead of the container's clock, and shows no identity pass running longer than 30 minutes. The watcher rewrites it every 30 s, so a watcher whose loop stopped, a data root uid 1001 can't write, or an identity pass that never ends turns it unhealthy. It doesn't catch a legacy derivative job that never finishes: a pass starts only once the legacy step is idle, and the legacy backlog on a first start can rightly take hours, so the healthcheck doesn't time it. The 30-minute limit can also flag a pass that's working as it should. A pass reads, hashes, and decodes every file whose size, inode, or times changed, so after a restore, after `identity/stat-cache.json` is deleted, or after a `chown -R` of the library, the first pass reads every photo again, and on a large library that can take longer than 30 minutes. The watcher shows unhealthy until that pass ends, so check its logs before acting on it. If `/media` sets stop appearing while the watcher reads healthy, check its logs for the last photo it processed. `restart: always` doesn't act on unhealthy, so this only changes what `ps` and a dashboard show. `docker compose -f docker-compose.prod.yml ps` shows the state, and the healthcheck's last lines say why:

```bash
docker inspect --format '{{json .State.Health}}' "$(docker compose -f docker-compose.prod.yml ps -q image-watcher)"
```

## Migration runbook

Run this once, on a library that never had a data root, to give every photo its ID. Until the catalog launches, Home and Gallery list the registry's photos at their legacy derivative URLs, so they show no photos until step 4 writes the registry. The legacy derivatives keep serving throughout.

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

4. Apply the plan the dry run printed. It writes the registry with exactly the plan's IDs, and `data-root.json`, after which `GET /api/health` reports `ready` and `GET /api/ready` reports `"state":"ok"`. If the library or the registry changed since the dry run, it refuses, so run the dry run again and apply that plan. Applying a plan twice prints that it's already applied and exits 0.

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

## Curation inbox

New photographs wait in the curation inbox until you approve them into the draft. Nothing there publishes. List it the same way as the other commands:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs curation list
```

`curation/rules.json` lets a folder or a filename tag suggest a series, and an EXIF date range narrow it. It must be a regular file of at most 256 KiB:

```json
{ "schemaVersion": 1, "series": [
  { "seriesId": "ser_example", "folders": ["trips/2024"], "filenameTags": ["harbor"],
    "capturedBetween": { "from": "2024-01-01", "to": "2024-12-31" } } ] }
```

The watcher works out an item's suggestion once, when it opens the item, and again only if a replacement file comes in while the item is still open. A rule that names a series with no authored record yet is skipped. So create the series first, with `photos edit <seriesId>`, then add its rule. A rule applies only to items opened after it. Items opened before it, including the ones for the photos already in the library when the inbox arrived, need `--series <seriesId>` on `approve`, or a series saved with `curation edit`.

A suggestion is only a draft. Approving the item is what places the photograph, and it takes the series you pass, the one you saved with `curation edit`, or the suggestion, in that order.

Replacing a published photograph's file with other bytes opens a `replacement` item and builds the new derivative set beside the old one. `curation show` says whether that set is still building, ready, or failed. Once it is ready, `curation confirm <eventId> --version <n> --base <revisionId>` points the photo record at the new bytes, keeping its photo ID, series, position, title, description, and story. To keep the revision the draft pins instead, leave the item in draft with `curation defer`. After a confirm, `curation reopen` and then `curation defer` put the photo record back on the revision the confirm replaced, so the next publish ships that one; if the record has moved since, defer refuses and writes nothing. That holds while the item's confirm is still the inbox's latest change to the photo's revision. Once a later item has changed it, defer on the earlier item puts nothing back, even when the later item's own defer put the record back on the earlier item's bytes: say B was confirmed in place of A, then C in place of B, then C's item was left in draft, which put B back. Leaving B's item in draft then keeps B, and `photos edit <photoId>` is the way back to A. `curation reopen` and `curation show` say which of these defer will do. If the record already pins the new bytes and no confirm of the item put it there, as after a hand edit, a `photos edit`, a rollback, or a crash between a confirm's two writes, defer writes nothing and says so. A confirm then records nothing to put back either, so a later reopen and defer keep the new bytes too. To go back to the earlier revision in that case, set `assetRevision` with `photos edit <photoId>`. Either way visitors keep the current image until the next `photos publish`. A failed set leaves the previous image and its derivatives as they were; `curation retry` builds it again.

Deleting, moving, or renaming a published photograph's file takes nothing down. The active revision keeps listing it, `/media` keeps serving its set from the data root, and the watcher opens a `missing` item. Settle it one of three ways:

- Put the same file back anywhere in the library. The watcher's next pass, or its next start if it was stopped, closes the item by itself.
- `curation bind <eventId> --version <n>` gives the photograph other bytes as an intentional replacement: the file found at its last path, which `curation show` lists as linked, or the one `--path <library path>` names. The watcher applies the bind on its next pass, and the new bytes then wait for `curation confirm` on their replacement item. Nothing binds by itself. The new photograph the watcher made of that file is merged into the missing one, so bind refuses one a series or the active revision shows, and `curation approve` refuses its new item while the bind waits. A file copied over another photograph's needs no merge: that photograph gives up the path and keeps its own identity. If the watcher refuses the bind, as when the file is gone by its next pass, `curation show` says why, and you can bind again.
- `curation archive <eventId> --version <n> --base <revisionId>` takes the photograph out of every series in the draft and archives it. That is the takedown. `photos publish --dry-run` lists it under Removed, and `photos publish` takes it off the site. Nothing is deleted: its sets stay in `assets/`, and copies already served as `immutable` can stay in browsers and caches.

A derivative build that still fails after the watcher's retry at start gets a `processing-failure` item. `curation retry` builds it again, and the item closes once the set is built. `curation list` shows the open missing and failed items.

## Retention and cleanup

Cleanup never deletes anything a visitor could be served or a rollback could need:

- Every revision in `catalog/revisions/`, every activation in `catalog/activations/`, and the active pointer.
- Every asset in `assets/`. Cleanup deletes no asset at all, so every set a revision, a candidate, or a working-layer record names stays. Deleting historical assets will need a later, explicit opt-in retention policy, and a source file being gone from the library is never a reason to delete one.
- The working layer in `authored/`, the registry in `identity/`, the curation inbox in `curation/`, `catalog/diagnostics/`, and `edits/`. Cleanup never reads or changes anything in `edits/`.

`photos.mjs gc` deletes two kinds of leftover, and only once each has gone unchanged for more than 7 days:

| Class | What it is | When it may go |
|---|---|---|
| `abandoned-staging` | `staging/<id>/`, a folder a derivative build left when it was killed before publishing its set | Nothing in it changed for more than 7 days, and no build holds its `build-<id>` lock. The delete takes that lock with no wait, so a live build's folder is skipped. |
| `orphan-candidate` | `catalog/candidates/<id>.json`, a compile that never became a revision | Its file and its `compiledAt` are both more than 7 days old, its ID has no revision, and no activation or the last publish summary names it. An active pointer that names a revision with no file stops GC altogether. |

Anything else in `staging/` or `catalog/candidates/` stays, such as a file, a symlink, or a name a build doesn't make. The watcher still clears a killed build's folder at start whatever its age, as it always has.

How a run goes:

1. `photos.mjs gc` is a dry run. It lists every path it would delete with its class, the rule that allows it, and its size, lists what of those two classes it keeps and why, and prints a plan digest. It deletes nothing.
2. `photos.mjs gc --apply <planDigest>` plans again and deletes only if the plan has the same digest, so a path added to the plan, gone from it, changed, or newly protected since the dry run stops it before it deletes anything. It prints the new plan then: check it, and apply its digest if it is still what you want. Each path is checked again just before its delete, and a change there stops the run. `--apply` logs one JSON line per path it deletes.
3. Both hold the catalog and authored locks from the scan through the last delete, waiting up to 30 seconds for each and naming the holder if they can't get it, so no publish, rollback, or record write lands in between.
4. Both stop, deleting nothing, if any revision, candidate, record, or the pointer can't be read, or if `staging/`, `catalog/`, or `catalog/candidates/` is a symlink, since then nobody can tell what a delete would reach. A symlink inside a staging folder is deleted as a link, never followed.
5. GC can't delete relative to an open folder, so just before each delete it re-verifies that the data root and every folder it deletes in are the ones it checked, and stops if any isn't. Keep the data root writable only by uid 1001, the user the containers run as.

`gc` exits 0 when it planned or applied, 1 when a folder it deletes in is a symlink, isn't a folder, resolves somewhere else, or changes just before a delete, 2 on a usage error, 4 when a catalog file is damaged or an I/O error stops it, and 3 on any other stop, such as a changed plan, a busy lock, or a data root that isn't ready. It runs in `image-watcher`'s container like the other commands:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs gc
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs gc --apply <planDigest>
```
