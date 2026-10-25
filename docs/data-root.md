# The data root: version folders and hand edits

`PHOTOGRAPHY_DATA_DIR` holds private state: the identity registry and the authored catalog records. This page covers only how those documents are stored and how to edit one by hand.

## One folder per document

Every document that two writers could change at once is a folder with one file per version:

| Document | Folder |
|---|---|
| Identity registry | `identity/registry/` |
| Site record | `authored/site/` |
| Series record | `authored/series/<seriesId>/` |
| Photo record | `authored/photos/<photoId>/` |

Inside each folder the versions are `v1.json`, `v2.json`, and so on. The highest number is the document. A write never changes an existing file. It adds the next number with `link()`, which fails if that number already exists, so two writers can't both store the same version. That's why the data root needs a filesystem with hard links (not exFAT or FAT).

Each write keeps the two newest versions and removes older ones. Files that start with `.v` and end in `.tmp` are writes in progress, or left by a write that crashed. The next write in that folder removes them. Leave them alone.

Every version carries a `stamp` with its own number and a hash of its content. That's how a command notices a file that was edited in place.

An older build stored each of these as one file: `identity/registry.json`, `authored/site.json`, `authored/series/<seriesId>.json`, `authored/photos/<photoId>.json`. This build refuses to read or write a document while its old file is there, and the message names the file. Move it into its folder as the next version (`v1.json` in an empty folder) while no command runs.

## Editing a document by hand

Only while no command runs: stop the `image-watcher` container, and don't run `photos:*` commands until you're done.

1. Copy the newest version to the next number, as the user that owns the data root (uid 1001 in the container setup). The folders are 0700 and the files 0600, so a plain `sudo cp` leaves a root-owned `v5.json` the app can't read. The registry then reads as unreadable, and a record as `unreadable`, until the copy gets the right owner. `cp -n` refuses to overwrite, so a typo can't replace a version:

   ```bash
   owner="#$(sudo stat -c %u "$PHOTOGRAPHY_DATA_DIR")"   # stat -f %u on macOS
   dir="$PHOTOGRAPHY_DATA_DIR/authored/photos/<photoId>"
   sudo -u "$owner" ls "$dir"                             # say v3.json and v4.json
   sudo -u "$owner" cp -n "$dir/v4.json" "$dir/v5.json"
   ```

   If you already copied it as root, give the copy the owner of the version it came from: `sudo chown --reference="$dir/v4.json" "$dir/v5.json"`.

2. Edit `v5.json` as the same user, for example `sudo -u "$owner" vi "$dir/v5.json"`. Leave its `stamp` as it is. A stamp that names another number marks the file as made by hand, and the next write stamps the version after it again. Leave `baseRevisionId` alone too, and in the site record `baseSeriesOrder`: publishing manages them, and they're how it tells your edits from the published ones.
3. Start the watcher again.

Never edit a version in place. A command that reads an edited newest version refuses it: `photos:identity status` reports the registry as unreadable and exits 1, the catalog lists the record as edited in place, and nothing writes on top of it. The message names the copy that recovers it (`cp -n v4.json v5.json`). Run that to keep the edit as a new version, or restore the file from a backup.

An edit that also changes or removes the stamp isn't caught. It reads as a version made by hand. An in-place edit of a hand-made copy isn't caught either, since its stamp already names another number. So finish the edit before the watcher starts again. Once the next write stamps a new version, that one is checked again.
