# The data root

The data root is `./portfolio-data` next to `docker-compose.prod.yml` on the host. It holds what the site knows about each photo beyond the file itself: a stable photo ID, every revision of the file's bytes, and the `/media` sets built from each revision. Every container mounts it at `/data/portfolio`, which `PHOTOGRAPHY_DATA_DIR` names. Only the watcher, `photos.mjs`, and the curator ([curator.md](curator.md)) write it, and `web` mounts it, and the library, read-only.

The registry in it names every photo by its path in the library and by the SHA-256 of its bytes, so the library and the data root only make sense together. Back them up together and restore them together.

## Layout

| Path | What it holds | Written by |
|---|---|---|
| `data-root.json` | The marker that says the folder is an initialized data root | `migrate --apply`, once |
| `identity/registry/v<N>.json` | Every photo ID, the photo's path, and its revisions, with the state of each revision's `/media` set. A [version folder](#version-folders): the highest `v<N>.json` is the registry. | The watcher, `migrate --apply`, and `identity` decisions |
| `authored/site/v<N>.json`, `authored/<kind>/<id>/v<N>.json` | The authored catalog records: the site record, and one version folder per series (`authored/series/<seriesId>/`) and per photo (`authored/photos/<photoId>/`) | `photos.mjs` `draft:init`, `describe`, `sequence`, `series`, `edit`, `carry-over`, and `review`'s stamps, a hand-made copy at the next version as [Editing a document by hand](#editing-a-document-by-hand) describes, `photos.mjs publish` and `rollback` when they rebase them, and the curator's Inbox, its Publish screen's review stamps, and its Publish and Restore, which rebase them the same way |
| `identity/stat-cache.json` | File sizes and times, so a pass doesn't hash files that haven't changed. Safe to delete, though the next pass then reads every photo again, as [Health](#health) says. | The watcher |
| `identity/decisions/` | `identity` decisions waiting for a pass, then filed under `applied/` or `rejected/` | `photos.mjs identity`, and `photos.mjs curation bind`, `archive`, `resolve`, and the `approve` that restores an archived photograph |
| `identity/migration/` | Dry-run plans and reports, and the mapping each apply wrote from paths and legacy URLs to photo IDs | `photos.mjs migrate` |
| `assets/<photoId>/<assetRevision>/<profileId>/` | One `/media` set: its WebP and AVIF files and `manifest.json`. A set never changes once it's written. | The watcher |
| `staging/` | Sets still being built | The watcher |
| `status/watcher.json` | The watcher's heartbeat, which its healthcheck reads | The watcher, every 30 s |
| `status/verify.json` | The last full `photos verify` run: when it ran, the active pointer it read, the chain's result, and each revision's, with up to 20 problems. The curator's Publish screen reads it for its rollback-ready line, and `photos rollback` and History refuse a revision it fails. A `photos verify --revision` pass replaces that revision's failed entry. Nothing runs verify on its own, so it's missing until you run it, which is fine. | `photos.mjs verify`, when you run it |
| `catalog/revisions/` | Every published revision, which never changes once it's written | `photos.mjs publish`, and the curator's Publish |
| `catalog/activations/` | Each activation: every publish and rollback adds one | `photos.mjs publish` and `rollback`, and the curator's Publish and Restore |
| `catalog/active/v<N>.json` | The pointer to the active revision. A [version folder](#version-folders), so a publish or a rollback moves it by adding the next version. | `photos.mjs publish` and `rollback`, and the curator's Publish and Restore |
| `catalog/candidates/`, `catalog/diagnostics/` | The last compile of each candidate, its issues, and how the last publish ended | `photos.mjs publish`, and the curator's Validate and Publish |
| `locks/` | The locks writers take on the registry, the authored records, the catalog, and the curation inbox | The watcher, `photos.mjs`, and the curator |
| `edits/` | `photos.mjs edit`'s working copies, and edits it kept because they couldn't be saved, which `edit <id> --file <path> --expect-version <N>` saves once fixed. Private, like the rest (0700, files 0600). Nothing reads them as records, and `references()` doesn't list them, so the cleanup #15 adds has to leave the folder alone. Delete a kept edit once it's saved or no longer wanted. | `photos.mjs edit` |
| `curation/events/<eventId>/v<N>.json` | One [curation inbox](#curation-inbox) item. A [version folder](#version-folders). Each version is stamped `schemaVersion` 1 when v1.7.0's schema, kept frozen in `lib/curation/events-v1.ts`, reads it, and 2 when it holds anything newer, such as a resolution, a `resolve` or `confirm-missing`, a restore, or a before-and-after. After a rollback to a v1.7.x image, the inbox lists each stamp-2 item as one that can't be read, `curation list` exits 4, `curation show` on it exits 4, and the watcher skips its facts. A field review that settled one goes stale, so a publish refuses that field until v2.0.0 is back or the item is restored from a backup. Stamp-1 items read as before. | The watcher, `photos.mjs curation`, `photos.mjs carry-over` (a dismissal), and the curator's Inbox |
| `curation/rules.json` | Your series suggestion rules for the inbox, if you want any | You |

Everything in it belongs to uid 1001, the user both containers run as, and only that user can read it, since the registry keeps curator-only details such as GPS. To read a file, go through the container instead of `sudo`:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher cat /data/portfolio/<path>
```

## Version folders

Every document that two writers could change at once is a folder with one file per version: `identity/registry/`, `authored/site/`, `authored/series/<seriesId>/`, `authored/photos/<photoId>/`, each curation inbox item's `curation/events/<eventId>/`, and the active catalog pointer, `catalog/active/`. Inside each folder the versions are `v1.json`, `v2.json`, and so on. The highest number is the document. A write never changes an existing file. It adds the next number with `link()`, which fails if that number already exists, so two writers can't both store the same version. That's why the data root needs a filesystem with hard links. Each writer checks first: it links a probe file in the data root, `.link-probe-<host>-<pid>-<id>`, and removes both names. A process killed between those steps leaves the probe behind. The next check on the same machine removes any probe over a minute old that its own host left, when the process that wrote it isn't running, or when it carries this process's ID but is older than this process (a container's writer is always process 1, so that's a restart in place). A recreated container, or a `docker compose run` command, gets a new host name, so its leftovers stay. Any `.link-probe-*` file over a minute old is safe to delete by hand.

Never edit the active pointer by hand: only `photos.mjs publish` and `photos.mjs rollback` move it, and the curator's Publish and Restore, which run the same two. A version copied there by hand makes a revision live without the checks a publish runs, so the next command refuses to record it if the rules block that revision.

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

Only while no command runs: stop the watcher and the curator, and don't run `photos.mjs` commands until you're done. The curator's Inbox and Publish screen write these records too. The folders are 0700 and the files 0600, owned by the user the app runs as (uid 1001 in the containers), so the new version has to keep that owner and mode. A copy root owns can't be read by the app: the registry then reads as unreadable, and a record as `unreadable`. With the containers, edit as uid 1001 from a shell in the watcher's image:

1. Stop the watcher and the curator, and open a shell. Stopping the curator does nothing when it's off already:

   ```bash
   docker compose -f docker-compose.prod.yml stop image-watcher curator
   docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher sh
   ```

2. Copy the newest version to the next number, and edit the copy. The newest is the highest number, not the last name `ls` prints: `v10.json` sorts before `v9.json`. The `test` and `cp -n` refuse to touch a `v5.json` that already exists, so a typo can't replace a version, and `vi` runs only on a copy just made:

   ```bash
   cd /data/portfolio/authored/photos/<photoId>
   ls                          # say v3.json and v4.json
   test ! -e v5.json && cp -n v4.json v5.json && vi v5.json
   ```

3. While you edit, leave the `stamp` as it is. A stamp that names another number marks the file as made by hand, and the next write stamps the version after it again. Leave `baseRevisionId` alone too, and in the site record `baseSeriesOrder`: publishing manages them, and they're how it tells your edits from the published ones. Leave an authored record's `review` alone as well. Once the upgrade's one-time review backfill has run, a field you change by hand no longer matches its review stamp, and a version without `review` is checked field by field against the values the backfill recorded, so a publish refuses a field you changed by hand as not reviewed ([Review state](#review-state)). Make a change you mean to publish with `photos.mjs edit` instead.
4. Leave the shell with `exit`, and start the watcher again, and the curator if you had it on:

   ```bash
   docker compose -f docker-compose.prod.yml start image-watcher
   docker compose -f docker-compose.prod.yml up -d curator   # only if it was on
   ```

Without the containers, as with the npm scripts' data root, do steps 2 and 3 on the host as root, keeping the owner and mode. `cp -p` keeps the owner and mode of the file it copies, and `sudoedit` writes back into the same file, so the copy keeps both. On the production host, set `PHOTOGRAPHY_DATA_DIR="$PWD/portfolio-data"` first, from the folder with `docker-compose.prod.yml`:

```bash
dir="$PHOTOGRAPHY_DATA_DIR/authored/photos/<photoId>"
sudo ls "$dir"                                    # say v3.json and v4.json
sudo test ! -e "$dir/v5.json" && sudo cp -n -p "$dir/v4.json" "$dir/v5.json" && sudoedit "$dir/v5.json"
```

The `test` and `cp -n` refuse to touch a `v5.json` that already exists, so a typo can't replace a version, and `sudoedit` runs only on a copy just made. `sudoedit` refuses a file in a folder you can write yourself, as when the app runs as your own user, and a path through a symlink in a folder you can write, as when `PHOTOGRAPHY_DATA_DIR` is a link in your home folder. The copy is then still an exact copy of `v4.json`, so nothing is lost: edit `v5.json` as the user who owns it (with your own editor when that's you), or for a link, run `sudoedit` on the resolved path, `sudoedit "$(sudo realpath "$dir/v5.json")"`. If you already copied it with a plain `sudo cp`, give the copy the owner of the version it came from: `owner="$(sudo stat -c %u:%g "$dir/v4.json")" && sudo chown "$owner" "$dir/v5.json"` (`stat -f %u:%g` on macOS).

Never edit a version in place. A command that reads an edited newest version refuses it: `photos.mjs identity status` reports the registry as unreadable and exits 1, the catalog lists the record as edited in place, and nothing writes on top of it. The message names the copy that recovers it (`cp -n v4.json v5.json`). Make that copy as in step 2, in the watcher's shell or with `sudo cp -n -p` on the host, to keep the edit as a new version, or restore the file from a backup.

An edit that also changes or removes the stamp isn't caught. It reads as a version made by hand. An in-place edit of a hand-made copy isn't caught either, since its stamp already names another number. So finish the edit before the watcher or the curator starts again. Once the next write stamps a new version, that one is checked again.

## Where it can live

- On a local POSIX filesystem on the same host as the containers, such as ext4 or XFS. The writers depend on atomic renames, hard links, `O_EXCL` lock files, and `fsync`, which NFS, SMB, and synced folders like Dropbox don't guarantee, and exFAT and FAT have no hard links at all. The watcher also refuses to build sets when `assets/` and `staging/` sit on different filesystems.
- Outside `public/` and the photo library. The containers treat a data root inside either one as `unavailable`, since anything under `public/` can end up served.
- In a folder that already exists. `docker-compose.prod.yml` never creates `./portfolio-data`, so if it goes missing, neither container starts. Compose won't quietly start over with an empty one.

## Setting it up

Before the first `up -d` with this compose file, create the data root and hand it to uid 1001. The photos need no `chown`: since v1.7.0 nothing in the stack writes them, and uid 1001 only has to read them, as [Who owns the photos](#who-owns-the-photos) says:

```bash
mkdir -p portfolio-data
sudo chown -R 1001:1001 portfolio-data
sudo chmod 700 portfolio-data
```

Compose files before #13's slice E (v1.6.0) also mounted `./.next-images-cache`, `web`'s `/_next/image` cache. Nothing on the site uses `/_next/image` now, so the file doesn't mount it, and a host that has one may delete it, as [releasing.md](releasing.md) says for v1.6.0. A rollback to an older release's compose file needs it back, owned by uid 1001.

Until the migration below initializes the data root, the watcher writes only its heartbeat there and logs once that the identity step is off. It writes nothing in the library, then or ever. `GET /api/health` reports `uninitialized`. The site serves only a published catalog revision, so until the first publish, `GET /api/ready` answers 503 with `not-published`, and Home and Work show #21's error page. There is no legacy Home or Gallery to fall back to.

### Who owns the photos

The containers run as uid 1001, and since v1.7.0 (#13's slice E) none of them writes the photos. The library, `./public/assets/photos` on the host, is mounted read-only at `/data/library` in `image-watcher` alone, and `PHOTOGRAPHY_LIBRARY_DIR` points there:

| Container | Reads | Writes |
|---|---|---|
| `web` | Nothing in the library, which it doesn't mount: every path under `/assets/photos` answers 404, and photos come from the `/media` sets in the data root | Nothing on the host |
| `image-watcher`, and each `run --rm` command in it | The originals, in every folder of the library, read-only at `/data/library` | The data root only |
| `curator` | Nothing in the library, which it doesn't mount: its screens read the registry and the `/media` sets. It sets `PHOTOGRAPHY_LIBRARY_DIR` only to keep the path out of its messages | The data root only |

So the photos can keep whatever owner they have, a file sync tool running as another user included, as long as uid 1001 can read them: every folder in the library readable and searchable, and every photo readable. The containers share no group with the tool unless you set one up, so in practice that means the world bits, folders at least `0755` and photos at least `0644`, and a tool set to create new files that way. A photo that arrives as `0600` gets no ID or `/media` set, so it never reaches the Inbox or the site, since the watcher can't read it. This prints every file or folder in the library that uid 1001 can't read, so no output means it can read them all:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher \
  find /data/library \( ! -exec test -r {} \; -o -type d ! -exec test -x {} \; \) -print
```

A library a watcher before v1.7.0 wrote into still has its legacy derivative folders (`thumbnails`, `medium`, `optimized`, `thumbnails-avif`, `medium-avif`, `optimized-avif`, `lqip`) and `cache/` at the top, often owned by uid 1001. They stay as they are: nothing reads or writes them, the identity scan skips those names, and #15's GC reclaims them once it ships. No step moves or deletes them. A host that ran `chown -R 1001:1001` on the photos for an older release can leave that as it is too, since reading is all uid 1001 does now. Every change of owner makes the watcher's next identity pass read every photo again, as [Health](#health) says, so don't `chown` the library back and forth. If a tool can leave folders out, leave out those eight.

## Never migrate into an empty data root beside a library that had IDs

`migrate --apply` gives a new photo ID to every photo the registry doesn't know. If a library already had a data root, migrating it again into an empty one gives every photo a new ID, and every link and catalog entry that names an old ID stops resolving. Afterwards, nothing tells the new IDs apart from a first migration's.

If `./portfolio-data` is lost or comes up empty on a host whose library had IDs, stop the watcher and restore the data root from a backup, as [Restoring](#restoring) describes. Run the migration only on a library that never had a data root.

## Backing up

While the stack runs, the watcher writes the data root, and so does the curator when it's on: its Inbox, its Publish screen's review stamps, Publish and Restore all write `authored/`, `catalog/`, `locks/` or `curation/events/`. Neither writes the library, but a backup copies both folders at one moment, so the data root's registry matches the photos it names. Stop both, archive both folders together, and start them again. The block starts the curator again only if it was running.

Both have to be real folders next to `docker-compose.prod.yml`, not symlinks. `tar` stores a symlink named on its command line as the link itself, not the files behind it, so the archive would hold no registry, and a restore's `mv` would move only the link. This block and the ones in [Restoring](#restoring) check that first, and stop before anything else runs. The `exit` leaves only the block's subshell, not your shell:

```bash
(
  for d in public/assets/photos portfolio-data; do
    [ -d "$d" ] && [ ! -L "$d" ] || { echo "$d must be a real folder, not a symlink. Nothing was archived." >&2; exit 1; }
  done
  mkdir -m 700 -p ~/photography-backups
  curator="$(docker compose -f docker-compose.prod.yml --profile curator ps -q --status running curator)"
  docker compose -f docker-compose.prod.yml stop image-watcher curator
  (umask 077 && sudo tar -czf - public/assets/photos portfolio-data >~/photography-backups/photography-$(date -u +%Y%m%dT%H%M%SZ).tar.gz)
  docker compose -f docker-compose.prod.yml start image-watcher
  [ -z "$curator" ] || docker compose -f docker-compose.prod.yml start curator
)
```

`sudo` lets `tar` read the uid 1001 files. Your own shell writes the archive, so it belongs to you, and `umask 077` and the 0700 folder keep it readable by you only, since it holds the registry and its curator-only details. Copy it off the host the same way, into a folder only you can read. If `tar` reports an error, delete that archive and run the block again, since the redirect leaves a partial file behind. `web` keeps serving meanwhile, since it only reads, but don't run `photos.mjs` commands or start the curator while `tar` runs.

## Restoring

Restore both folders from the same archive, so the registry describes the library beside it. Move the current folders aside instead of deleting them until the restored stack checks out. The timestamp keeps a second restore from moving them inside an earlier one's. Extracting as root with `-p` keeps the files' owners and modes. The blocks stop `web`, `image-watcher` and `curator`, and start the curator again only if it was running, so a service an override adds keeps running. Stop the curator first, even though it's often off: one left running would keep writing into the folder the restore moves aside, so a publish or restore from it would never reach the restored data root:

```bash
(
  for d in public/assets/photos portfolio-data; do
    [ ! -L "$d" ] || { echo "$d is a symlink. Nothing was moved or restored." >&2; exit 1; }
  done
  curator="$(docker compose -f docker-compose.prod.yml --profile curator ps -q --status running curator)"
  docker compose -f docker-compose.prod.yml stop web image-watcher curator
  aside=before-restore-$(date -u +%Y%m%dT%H%M%SZ)
  sudo mv public/assets/photos "photos.$aside"
  sudo mv portfolio-data "portfolio-data.$aside"
  sudo tar -xzpf ~/photography-backups/photography-<timestamp>.tar.gz
  docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs verify ||
    echo "photos verify found a problem, listed above. The stack starts anyway: fix what it names before you rely on a rollback." >&2
  docker compose -f docker-compose.prod.yml up -d web image-watcher
  [ -z "$curator" ] || docker compose -f docker-compose.prod.yml up -d curator
)
```

`photos.mjs verify` runs before the stack starts again. It reads every revision, the rules on it, and every `/media` set's digests, and checks the activation chain, so it catches a set the archive holds only part of, or a file that changed on the way. It writes its result to `status/verify.json`, which the curator's Publish screen reads, and changes nothing else. If it finds a problem it says what to put back, and the block starts the stack anyway, so `web` serves what it can. The README's [Verify](../README.md#verify) section has the details.

Then check that `photos.mjs identity status` counts the photos you expect, as in step 6 of the runbook, and that `GET /api/health` reports `ready`.

If only the data root was lost and the library is fine, restore just `portfolio-data` from the newest archive and keep the current library. Move whatever is left of `./portfolio-data` aside first, as above. `tar` overwrites only the files the archive has and keeps the rest, so files written after the archive would otherwise stay beside the restored ones. A newer decision would apply to the older state, and a newer registry version, with the highest number in `identity/registry/`, would still be the registry:

```bash
(
  [ ! -L portfolio-data ] || { echo "portfolio-data is a symlink. Nothing was moved or restored." >&2; exit 1; }
  curator="$(docker compose -f docker-compose.prod.yml --profile curator ps -q --status running curator)"
  docker compose -f docker-compose.prod.yml stop web image-watcher curator
  sudo mv portfolio-data "portfolio-data.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  sudo tar -xzpf ~/photography-backups/photography-<timestamp>.tar.gz portfolio-data
  docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs verify ||
    echo "photos verify found a problem, listed above. The stack starts anyway: fix what it names before you rely on a rollback." >&2
  docker compose -f docker-compose.prod.yml up -d web image-watcher
  [ -z "$curator" ] || docker compose -f docker-compose.prod.yml up -d curator
)
```

The watcher's next pass keeps the ID of every photo that archive knew, follows a photo renamed since by its bytes, marks one deleted since as missing, and gives new IDs only to photos added after the archive was made. That loses far less than migrating again.

## Health

`GET /api/health` answers 200 whenever `web` is up, with the data root's state: `ready`, `uninitialized`, `unavailable`, or `unset`. Both `web` healthchecks call it.

`GET /api/ready` says whether `web` can serve the photos, and which catalog revision: `"state":"ok"` with `revisionId`, `revisionNumber`, and `activatedAt`, or `"degraded"`, still serving the last revision it loaded because the current one can't be read. Its `mode` is always `"catalog"` since #13's slice E removed legacy mode, and is kept so a check written for an older release still reads it. It answers 503 with a `reason` when it can serve nothing. `not-published` means nothing was ever published here, or no data root is set: there is nothing to serve, and no legacy site to fall back to. `catalog-unreadable` means `web` can't read `catalog/` well enough to tell whether anything was published, for example when a command run as another user left it unreadable to uid 1001. It serves nothing until `catalog/` reads again, and then answers `not-published` if nothing was. `active-unreadable` and `revision-unreadable` mean a site that has published can't read its pointer or the revision it names, and has no revision loaded to serve meanwhile.

The watcher's healthcheck runs `node dist/scripts/watcherHealth.mjs`, which passes while `status/watcher.json` is at most 120 s old, isn't stamped more than 120 s ahead of the container's clock, and shows no identity pass running longer than 30 minutes. The watcher rewrites it every 30 s, so a watcher whose loop stopped, a data root uid 1001 can't write, or an identity pass that never ends turns it unhealthy. It also reads unhealthy while the last pass found no photo in the library at all though the registry has photos present, as an unmounted or not-yet-mounted share looks, or found the library folder missing or unreadable (v2.0.0): such a pass marks nothing missing and writes nothing, and the watcher looks again after a minute, then after 2, 4 and 8 minutes, and every 10 minutes after that, until the photos are back. It logs the cause once, not on every look, and opens the inbox's `library-unavailable` item (below). The 30-minute limit can also flag a pass that's working as it should. A pass reads, hashes, and decodes every file whose size, inode, or times changed, so after a restore, after `identity/stat-cache.json` is deleted, or after a `chown -R` of the library, the first pass reads every photo again, and on a large library that can take longer than 30 minutes. The watcher shows unhealthy until that pass ends, so check its logs before acting on it. If `/media` sets stop appearing while the watcher reads healthy, check its logs for the last photo it processed. `restart: always` doesn't act on unhealthy, so this only changes what `ps` and a dashboard show. `docker compose -f docker-compose.prod.yml ps` shows the state, and the healthcheck's last lines say why:

```bash
docker inspect --format '{{json .State.Health}}' "$(docker compose -f docker-compose.prod.yml ps -q image-watcher)"
```

## Migration runbook

Run this once, on a library that never had a data root, to give every photo its ID. The site shows nothing until the first publish, before and after it: `GET /api/ready` answers 503 with `not-published`.

1. Stop the watcher, so the library holds still:

   ```bash
   docker compose -f docker-compose.prod.yml stop image-watcher
   ```

2. Back up both folders, as [Backing up](#backing-up) describes. The watcher is already stopped, so skip its `stop` and `start`, and keep the curator off.

3. Dry-run the migration in `image-watcher`. It proposes an ID for every photo, writes only a plan and a report to `identity/migration/`, and prints both paths. Then read the report:

   ```bash
   docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs migrate --dry-run
   docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher cat <report path>
   ```

   Check its duplicate-byte groups, basename collisions, unreadable, unsupported, and undecodable files, and ambiguous items. An ambiguous file gets no ID until you decide with `photos.mjs identity bind` or `new`.

4. Apply the plan the dry run printed. It writes the registry with exactly the plan's IDs, and `data-root.json`, after which `GET /api/health` reports `ready`. `GET /api/ready` still answers `not-published` until the first publish. If the library or the registry changed since the dry run, it refuses, so run the dry run again and apply that plan. Applying a plan twice prints that it's already applied and exits 0.

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

Replacing a published photograph's file with other bytes opens a `replacement` item and builds the new derivative set beside the old one. `curation show` says whether that set is still building, ready, or failed. Once it is ready, `curation confirm <eventId> --version <n> --base <revisionId>` points the photo record at the new bytes, keeping its photo ID, series, position, title, description, and story. To keep the revision the draft pins instead, leave the item in draft with `curation defer`. After a confirm, `curation reopen` and then `curation defer` put the photo record back on the revision the confirm replaced, so the next publish ships that one; if the record has moved since, defer refuses and writes nothing. That holds while the item's confirm is still the inbox's latest change to the photo's revision. Once a later item has changed it, defer on the earlier item puts nothing back, even when the later item's own defer put the record back on the earlier item's bytes: say B was confirmed in place of A, then C in place of B, then C's item was left in draft, which put B back. Leaving B's item in draft then keeps B, and `photos edit <photoId>` is the way back to A. `curation reopen` and `curation show` say which of these defer will do. If the record already pins the new bytes and no confirm of the item put it there, as after a hand edit, a `photos edit`, a rollback, or a crash between a confirm's two writes, defer writes nothing and says so. After a crash, run `curation confirm` again: the record's review stamp shows the item's confirm wrote it, so the confirm records the revision it replaced, and a later reopen and defer put that one back once its derivative set is ready. Until then defer refuses, and `curation show` says so before you try. After a hand edit, a `photos edit`, or a rollback, the stamp doesn't name the item, so a confirm records nothing to put back, and a later reopen and defer keep the new bytes too. To go back to the earlier revision in that case, set `assetRevision` with `photos edit <photoId>`. Either way visitors keep the current image until the next `photos publish`. A failed set leaves the previous image and its derivatives as they were; `curation retry` builds it again.

Deleting, moving, or renaming a published photograph's file takes nothing down. The active revision keeps listing it, `/media` keeps serving its set from the data root, and the watcher opens a `missing` item. Settle it one of three ways:

- Put the same file back anywhere in the library. The watcher's next pass, or its next start if it was stopped, closes the item by itself.
- `curation bind <eventId> --version <n>` gives the photograph other bytes as an intentional replacement: the file found at its last path, which `curation show` lists as linked, or the one `--path <library path>` names. The watcher applies the bind on its next pass, and the new bytes then wait for `curation confirm` on their replacement item. Nothing binds by itself. The new photograph the watcher made of that file is merged into the missing one, so bind refuses one the live site shows, even once it's taken out, one a draft series lists until it's taken out, one an older revision `photos rollback` can go back to lists, since that revision could then never come back (a revision a crashed publish wrote but never activated doesn't count), and one whose photo record in the draft holds anything you set, such as a title, description, or focal point, which the merge would drop. A bare record, as `draft:init` writes it, doesn't stop a bind: the merge leaves it unused in `authored/photos/`, and the bind's note says so. `curation approve` refuses the new photograph's item while the bind waits. A file copied over another photograph's needs no merge: that photograph gives up the path and keeps its own identity. When the watcher holds the path in doubt between two other photographs, bind refuses it, so settle that path's ambiguous item first, with `curation resolve` or `curation bind --to`, below. While a bind waits, `curation archive` refuses the missing item too. If the watcher refuses the bind, as when the file is gone by its next pass, `curation show` says why, and you can bind again.
- `curation archive <eventId> --version <n> --base <revisionId>` takes the photograph out of every series in the draft and archives it. That is the takedown. `photos publish --dry-run` lists it under Removed, and `photos publish` takes it off the site. The pass that applies the archive also closes the photograph's `new` item as `resolved`, approved or not, so the inbox doesn't ask you to judge or place it again. Nothing is deleted: its sets stay in `assets/`, and copies already served as `immutable` can stay in browsers and caches.

Besides the same file back at the same path, the watcher links a file to a missing photograph when other bytes turn up at its last path, and `curation bind` with no `--path` takes that one linked file. Other pixels at a new path with its file name or its capture time are only suggested: `curation show` lists them, and you pick one with `--path`, since another shoot's `IMG_0001.JPG` has the same name. `curation confirm-missing <eventId> --version <n>` records that the file is gone on purpose. It writes the item and nothing else, and the item stays open, since bind or archive still settles it.

An archived photograph can come back. When its bytes, or the same pixels in other bytes, turn up in the library again, the watcher makes a new photograph of the file and says it's a copy of the archived one. Approving that new item, with no series, position, or description, writes a `restore` decision instead of a photo record: the watcher's next pass gives the file back to the archived photograph under its old ID, with its photo record and copy as they were, merges the new photograph into it, and closes the new item as `resolved` (`restored`). The archived photograph's own `new` item opens again then, so you can place it in a series. On the Inbox page that's Approve with no series and no description. The edits saved on the item aren't used, and the approval says so. Approve refuses a new photograph a series, the live site, or a revision `photos rollback` can go back to already shows, or whose photo record holds anything you set, since the merge would retire it and drop that copy. It also refuses a second duplicate while a restore of the same photograph waits. `curation show` says a restore is pending, with when and who asked. If the watcher refuses it, as when the file moves before its next pass, or after a v1.7.x rollback, which doesn't know restores, the item opens again for judgment, and `curation list` and `show` say why. The archived photograph stays archived until you approve again.

An `ambiguous` item, a file the watcher holds in doubt, waits for your answer:

- `curation resolve <eventId> --version <n> --as new` makes the file a photograph of its own, whose `new` item then places it.
- `curation resolve <eventId> --version <n> --as replacement-of <photoId>` makes it new bytes for that photograph, whose file is gone or which the watcher holds this file in doubt for. Its `replacement` item then reviews the bytes, unless they are the photograph's own.
- `curation bind <eventId> --version <n> --to <photoId>` says the file is one of the photographs the watcher holds it in doubt for. For any other photograph it refuses and names the `resolve --as replacement-of` that does it.

Each writes one decision for the watcher's next pass, which applies it and closes the item, and `curation show` says it's pending, with when you asked and who asked, or why the watcher refused it. One answer waits at a time. `curation resolve <eventId> --version <n> --as new` also takes a `replacement` item whose file is really another photograph: the file becomes its own photograph, the item closes as `split` once the watcher applies it, and the photograph it replaced goes missing, its published output still serving. `photos.mjs identity bind` and `new` still work too.

A `replacement` item records the file's before and after, against the revision the photo record pinned when it opened: oriented size, aspect ratio, orientation, capture date, and bytes. `curation show` prints both and says to check the crop, focal point, and description when the aspect ratio moves by more than 1% or the orientation flips, as a file saved with another EXIF orientation does.

A derivative build that fails for a reason that can pass, such as a full disk or too many open files, is tried again after 30 s, 2 min, and 10 min (v2.0.0). Until then its entry in the registry stays pending, with `retries` and `retryAt`, so a watcher restart keeps the schedule rather than starting it over or building early, and `photos status --check` counts it as retrying. One that fails all three is recorded as `retries-exhausted`. A failure the same bytes would only repeat isn't retried: `io-error` (the file reads EACCES, EPERM or EIO), `decode-error` (the decoder refuses the bytes, which the build checked by digest first), `unsupported-format`, `too-large` (over 200 million pixels, checked before decoding and by the decoder itself), and `corrupt-destination` (a set already in `assets/` that doesn't match its manifest, which the watcher never overwrites). The watcher logs one JSON line per build, `{"event":"derivative-build",...}`, with its outcome (`built`, `kept`, `retrying`, `failed`, `superseded`, `pending` or `skipped`), and the code or the retry's number and time. It names no path. `--once` exits 1 while a build waits for its retry: run it again after that time, or leave it to the watcher. A watcher older than v2.0.0 records every failure at once, and the first v2.0.0 start puts each of those back to pending once, as before.

A build that still fails gets a `processing-failure` item. `curation retry` builds it again, and the item closes once the set is built. `curation list` shows the open missing and failed items, and `photos status` lists each one, with what still shows a missing photograph.

The watcher keeps one `library-unavailable` item for the library itself (v2.0.0). It opens when a pass finds the library folder missing, empty while the registry has photos present, or unreadable, and when one pass marks at least 20 photographs and over 10% of the ones bound to a file missing, as a network share under the library that drops out looks. A pass that finds the folder missing, empty or unreadable changes nothing, so no photograph goes missing while the mount is gone. A pass that marks that many missing still records what it saw, since nothing is taken down by it, but the `missing` items it opens are held: `photos status` counts them as held, not missing, and `--check` fails on the library instead of on each photograph. The watcher reports a library folder missing at start, or gone while watch mode runs, before it exits 1, and the container's restart finds the same item open, so a library that stays gone writes nothing more. The item closes, as `resolved`, once a pass reads the library again, unless the photographs it holds are still missing past the same 20 and 10%; closing it releases what it held, so a file that is really gone then counts as missing. `curation confirm-missing` on a held item releases that one, and `curation dismiss` on the library item releases them all. `curation show` on it says the cause and since when. Fix the mount, its permissions, or `PHOTOGRAPHY_LIBRARY_DIR`; nothing in the library needs to change.

A file that reads EACCES, EPERM or EIO three passes in a row gets a `processing-failure` item with `io-error` (v2.0.0), once for that version of the file. Until then the watcher skips it, counting the passes in `identity/stat-cache.json`, and a photograph bound to it stays as it was. Once the file reads again, the watcher picks it up by itself; dismiss the item then.

`photos status` counts the inbox: what needs review, counted as `curation list` and the Inbox count it, the open missing, failed and ambiguous items, and the stale approvals, whose photograph no series or the live revision holds any more, as after a rollback or a `sequence remove`. It lists each of the last four, a missing source with how long ago it went missing. `photos status --check` is the form for a monitor or a cron job. It exits 1 on an open `library-unavailable` item, on an open missing, failed or ambiguous item that item doesn't hold, on an inbox item it can't read (which may be one of those), on a watcher pass that failed last, on a watcher that still beats but has got no pass through for over 30 minutes (a registry that stays locked, or one pass that never ends), or on a heartbeat (`status/watcher.json`) more than 5 minutes old or stamped that far ahead of the clock, and prints each reason under `Check: failed.`. It exits 0 otherwise, with `Check: passed.`, so new photographs waiting for review and stale approvals don't fail it, and neither does a last pass that refused an empty library: the `library-unavailable` item reports that, and the watcher's healthcheck already fails on it. Before its verdict, `--check` prints `Held: N missing sources. Builds: R retrying, P failed for good.`: the missing items the library item holds, the builds waiting for a retry, and the builds that failed for good, which the failures above already count by item. None of the three fails the check by itself. It also exits 1 whenever plain `status` would. With `--json`, the output adds `check`: `ok` and a `problems` list, each with a `code` (`status-incomplete`, `library-unavailable`, `inbox-unreadable`, `missing-open`, `failed-open`, `ambiguous-open`, `last-pass-failed`, `pass-stalled`, `heartbeat-missing` or `heartbeat-stale`) and a `message`, and `counts` (`held`, `retrying`, `permanent`), and if status itself fails, `--json` still prints JSON: the `error` and a `check` with `status-incomplete`. The 5 minutes are ten of the watcher's beats, looser than its container healthcheck's 120 s, so a slow pass or a restart doesn't page. The 30 minutes are three of the passes an idle watcher makes every 10 minutes, measured from the heartbeat's `lastProgressAt`, when a pass last got through (committed, or refused a missing, empty or unreadable library), or the watcher's start before the first. A heartbeat from a watcher older than v2.0.0 has no `lastProgressAt`, so the check reads its last pass, or the pass under way.

The watcher also closes these items by itself, as `resolved`, once what they asked about is over, and opens one again if it comes back:

- A `replacement` closes once the photograph's file holds other bytes again, whether or not its set had built: the newer file's own item is the one to review, so two quick re-exports leave one open replacement. When the file went back to bytes it held before, the item closes as `reverted`, and so does the earlier bytes' own item when the photo record already pins them, since there's nothing to confirm. If the bytes come back, the item opens again. One you left in draft with `curation defer` stays in draft, since that was your call, and `photos status` doesn't count its refused set as a failure.
- A missing photograph that no catalog revision and no draft series lists, and whose photo record holds nothing you set, is withdrawn: its file going takes nothing down, so its open `missing` item, and its open `new` item, close as `withdrawn`. A deferred item stays as you left it. So does a missing item a bind waits for, and the items of a photograph whose failed build still has an open item, which `curation archive` settles. The `new` item opens again when the file comes back, and both do if a series, a revision, or the copy on its record lists the photograph while its file is still gone.
- The `library-unavailable` item closes once a pass reads the library again, as above, and opens again on the next outage.
- An `ambiguous` item closes once the watcher no longer holds its file in doubt: after your `curation resolve` or `bind --to`, or `photos.mjs identity bind` or `new`, is applied on the next pass, or when the file changes or leaves the library. It closes even when left in draft, since no question is left. While the same bytes are still in doubt at another path, it stays open, and it opens again if they come into doubt again.

## Review state

Every write through the tools stamps what it changed in the authored record's `review`: a hash of the value, the active revision it was reviewed against, the photo's asset revision, the inbox item it settled, who wrote it, and when. A value you type or choose is reviewed as it is written. A suggested description (`"reviewed": false`) stays a suggestion until you mark it reviewed. The first command after the upgrade that takes the authored lock records a one-time backfill in `authored/review-backfill.json`: every record without `review` at that point, records you made by hand included, counts as reviewed against its own `baseRevisionId`, except such a suggestion, and its first write keeps that for the fields it doesn't change. It also records the value each field held, so after it a field changed by hand reads as not reviewed, and so does every field of a record folder made by hand after it. Never edit or delete `review-backfill.json`: the next command would write a new one, taking every hand edit made since the upgrade as reviewed. If it can't be read, the gate refuses the hand-made records and says so, and the tools refuse to write a hand-made record until it's back; restore it from the data-root backup.

`photos.mjs validate` and `publish` compare the draft with the active revision and refuse a change visitors would see whose review is missing or stale (`review.authored-change`), naming the record, the field, and what to do. A review goes stale when:

- a rollback publishes the field differently from the revision it was reviewed against. A publish never does: what it publishes came from your own draft. Approving a new photograph's inbox item again, as `curation show` advises after a rollback, reviews its photo record's fields against the active revision: each one that still holds the value last reviewed, other than a suggested description or bytes a confirm chose;
- a photograph's description, title, caption, focal point, crop, or accent was reviewed for other bytes than the ones its record pins now, or a series cover for other bytes than its photograph's;
- the inbox item it settled is open again, or a newer replacement of the same photograph waits in the inbox. Confirm it, or leave it in draft, and the publish goes through. A reopened new photograph that a series still holds counts as already placed in `curation list`, so the refusal names its `curation show`: approve it again or leave it in draft.

A field changed by hand reads as not reviewed. To clear one, put the field back as it was, then make the change with `photos.mjs edit`. A stale review whose value is still right clears with **Still right, mark reviewed** on the Publish screen, and a hand edit you mean with **Mark reviewed**, or with `photos.mjs diff` and `photos.mjs review` on a host without the curator ([README](../README.md#reviewing-what-a-publish-changes)). Settling a `conflicts` entry with `photos.mjs edit` reviews that field too. A publish of a draft that changes nothing visitors see stops with `NO_CHANGES` and writes no revision or activation (`review.empty-diff` refuses one that differs from the active revision but changes nothing visitors see). A rollback is never blocked by either rule: a stored revision was reviewed when it was first published.

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
