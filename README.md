# Photography Portfolio

A modern, high-performance photography portfolio website built with Next.js 16, featuring a beautiful glassmorphism design, optimized image delivery, and seamless dark/light theme support.

**🌐 Live Demo:** [https://keyurgolani.photography/](https://keyurgolani.photography/)

![Version](https://img.shields.io/github/v/tag/keyurgolani/keyurgolani.photography?label=version)
![Next.js](https://img.shields.io/badge/Next.js-16.1.4-black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)
![License](https://img.shields.io/badge/License-MIT-green)

> A self-hostable photography portfolio with a glassmorphism UI, masonry gallery, full-featured lightbox, dark/light theming, and an automatic Sharp-powered image pipeline (AVIF/WebP, EXIF captions).

<p align="center">
  <img src="docs/screenshots/gallery-dark.png" alt="Masonry photo gallery" width="49%" />
  <img src="docs/screenshots/about.png" alt="About page" width="49%" />
</p>

<p align="center"><em>Immersive hero carousel, masonry gallery, and lightbox viewer.</em><br/>
👉 <strong><a href="SHOWCASE.md">See the full visual showcase »</a></strong></p>

## ✨ Features

### 🎨 Design
- **Glassmorphism UI** - Modern frosted glass effects with backdrop blur
- **Dark/Light Theme** - Dark by default, with a light theme the site remembers once you pick it
- **Responsive Design** - Optimized for all screen sizes from mobile to desktop
- **Smooth Animations** - Framer Motion powered transitions and micro-interactions
- **Auto-hiding UI** - Clean immersive viewing with context-aware UI visibility

### 🖼️ Gallery
- **Masonry Grid Layout** - Dynamic grid with best-fit image placement
- **Lightbox Viewer** - Full-featured image viewer with zoom, slideshow, and thumbnails
- **Lazy Loading** - IntersectionObserver-based lazy loading for optimal performance
- **LQIP Placeholders** - Low Quality Image Placeholders for smooth loading
- **Blur-up Effect** - Images transition from blurry to sharp as they load

### ⚡ Performance
- **Next.js Image Optimization** - Automatic AVIF/WebP format negotiation
- **Multi-size Image Pipeline** - Pre-generated thumbnails (400px), medium (800px), and full (1920px)
- **Registry-backed Photo List** - `/api/photos` reads the photo registry instead of decoding photos, and rebuilds only when the registry changes
- **Docker Ready** - Production-optimized containerized deployment

### 🔧 Technical
- **Sharp Image Processing** - High-quality image optimization with AVIF support
- **Background Image Watcher** - Automatic processing of new photos
- **EXIF Extraction** - Automatic caption generation from photo metadata
- **Environment Variables** - Configurable UI timeouts and photo library folder

## 🚀 Quick Start

### Prerequisites
- Node.js 24 LTS (see `.nvmrc`)
- npm or yarn
- Docker (optional, for containerized deployment)

### Development

```bash
# Clone the repository
git clone https://github.com/keyurgolani/keyurgolani.photography.git
cd keyurgolani.photography

# Install dependencies
npm install

# Give the library's photos their IDs, once. The dry run prints the plan to apply.
npm run photos:migrate -- --dry-run
npm run photos:migrate -- --apply --plan <plan path>

# Start development server
npm run dev

# In a second terminal, build the photos' derivatives, then keep watching for new ones
npm run images:watch
```

Open [http://localhost:3000](http://localhost:3000) to view the site. `npm run dev` and `npm start` listen on `127.0.0.1` only. The Gallery lists the photos the migration recorded in `./portfolio-data`, the data root the npm scripts use by default, so until it has run, `/api/photos` answers 503 and the Gallery is empty. `npm run dev` alone builds no derivatives, and the Gallery lists a photo only once all seven of its derivatives exist, so it also stays empty until the watcher has run. `npm run images:process` builds them once and exits.

Outside production, `PHOTOGRAPHY_DATA_DIR` defaults to `./portfolio-data`, so the watcher here (and in the dev compose) runs with its identity watch on whether or not you set it. The identity pass itself waits until `photos:migrate --apply` initializes that folder.

### Development with Docker

`docker-compose.yml` runs `next dev` and the photo watcher against your checkout:

```bash
docker compose up
```

It listens on `127.0.0.1:3000` only. Open [http://localhost:3000](http://localhost:3000), since the dev server in the container accepts hot reload only from `localhost`. To open it from another machine, forward the port over SSH rather than publishing it wider:

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:3000:127.0.0.1:3000 <host>
```

After a dependency change, rebuild with `docker compose up --build -V`. Without `-V`, the anonymous `node_modules` volume keeps the old install. Both containers use `./portfolio-data` in your checkout as the data root, the same folder the npm scripts use by default. On Linux, both containers run as root, so if Compose creates `./portfolio-data` or the watcher writes it, those files belong to root with mode 0600 and the npm scripts on the host can't read them. Create the folder yourself before the first `docker compose up`, and use either the containers or the npm scripts for one data root, or `sudo chown -R "$(id -u):$(id -g)" portfolio-data` when switching to the npm scripts. Docker Desktop on macOS maps the files to your user, so this doesn't come up there.

### Production with Docker

Both containers run one pinned release tag. Set it in a `.env` next to `docker-compose.prod.yml`:

```bash
PHOTOGRAPHY_IMAGE_TAG=vX.Y.Z
```

Both also mount the private data root, `./portfolio-data`, and `web` mounts `./.next-images-cache`, its `/_next/image` cache. Both have to exist and belong to uid 1001 before the first start, since Compose never creates them. On a host where nothing else writes the photos, hand the photos folder to uid 1001 too:

```bash
mkdir -p portfolio-data .next-images-cache
sudo chown -R 1001:1001 public/assets/photos portfolio-data .next-images-cache
sudo chmod 700 portfolio-data
```

If another process writes the photos, such as a file sync tool running as another user, leave `public/assets/photos` out of that `chown` and give uid 1001 only the folders the watcher writes, as [Who owns the photos](docs/data-root.md#who-owns-the-photos) describes. [docs/data-root.md](docs/data-root.md) also covers what the data root holds, backing it up with the library, restoring it, and the one-time migration that gives every photo its ID.

Then pull and start:

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

The site listens on the host's 127.0.0.1 only, port 3000 unless `PHOTOGRAPHY_PORT` in `.env` says otherwise. A reverse proxy or tunnel on the same host serves it from there. One that runs in a container can't reach the host's 127.0.0.1, so it joins this project's network and uses `http://web:3000`, or a network alias for `web` when its origin names another host, as [docs/releasing.md](docs/releasing.md) describes for the first release with slice C of #10. The same section covers a host whose boot service runs a plain `docker compose up`, which links `docker-compose.yml` to `docker-compose.prod.yml` and names its override `docker-compose.override.yml`, and removing containers left from older service names.

Most commands in this README and in [docs/](docs/) name `-f docker-compose.prod.yml` alone, for a host with no override. On a host with one, give every command the same files the host's Compose loads: plain `docker compose` with the layout above, or `-f docker-compose.prod.yml -f <override>`. `-f docker-compose.prod.yml` alone leaves the override out, so a command run that way can mount another photos folder or data root than the site's.

[docs/releasing.md](docs/releasing.md) covers cutting a release, deploying, rollback, and telling what's running.

## 📁 Project Structure

```
├── app/                    # Next.js App Router pages
│   ├── api/               # API routes: the photo list, health, and readiness
│   ├── gallery/           # Gallery page
│   ├── about/             # About page
│   └── page.tsx           # Home page
├── components/            # React components
│   ├── Gallery.tsx        # Masonry gallery grid
│   ├── home/              # Home slideshow, its controls, and playback
│   ├── ThemeToggle.tsx    # Dark/light theme switcher
│   └── LoadingAnimation.tsx # Loading screen animation
├── utils/                 # Utility functions
│   ├── imageOptimizer.ts  # Sharp-based image processing
│   └── watcherHandlers.ts # Watcher event handlers and job queue
├── scripts/               # Background scripts, bundled into dist/scripts for the image
│   ├── imageWatcher.ts    # File watcher for new photos
│   ├── photos.ts          # Photo ID, identity, and catalog commands
│   └── watcherHealth.ts   # The watcher container's healthcheck
├── public/                # Static assets
│   └── assets/photos/     # Photo storage directory
└── docker-compose.prod.yml # Production Docker configuration
```

## 🖼️ Adding Photos

1. **Drop photos** into `public/assets/photos/` directory
2. **Image watcher** automatically processes them:
   - Generates thumbnails (400px)
   - Creates medium size (800px)  
   - Optimizes full size (1920px)
   - Extracts EXIF data for captions
   - Creates LQIP placeholders
3. **Gallery updates** on the next page load once the watcher has recorded the photo in the data root and written all seven of its derivatives, and the original file is never served. The production server serves only the `public/` files that existed when it started, so restart `web` for photos added since to load there.

### Replacing and Removing Photos
- **Replace** a photo by saving over it under the same name. The watcher regenerates its derivatives from the new file and swaps them in only once all seven are written, so a failed run keeps the old ones. Visitors can still see the old version for a while: `/_next/image` can serve its copy for up to a day, and a browser that cached it under the old `immutable` header may keep it for up to a year.
- **Accepted risk:** a different photo saved under a removed photo's name, with an older modification time, shows the old images until you `touch` it or run `--force`. Copy tools that keep modification times, such as `cp -p` and `rsync -a`, do this. A photo that takes over a set another photo built, such as `IMG_1.jpg` added next to `IMG_1.png`, doesn't have this problem. Each set records the source it was built from, so the watcher rebuilds it when the file arrives, or at its next start if it was stopped.
- **Delete** a photo to hide it from the gallery, before the launch. `/api/photos` stops listing it once the watcher's next pass records it missing. Nothing deletes its derivative files, which stay reachable at their URLs, so restoring the file brings the photo back with nothing to rebuild. To take it offline, follow the next item. After the launch, deleting the file hides nothing: the active catalog revision keeps listing the photo, and `/media` keeps serving it. Take it down as the item after next describes.
- **Take a photo down** with the watcher stopped, so a job already running can't write its derivatives back:
  1. Stop `image-watcher`, then delete the photo.
  2. Delete its seven derivatives and `cache/set-sources/<name>.json`, the record of which source its set was built from, where `<name>` is the photo's file name without its extension, such as `landscape`. Do the same for each earlier name the photo had, which the listing below finds. If another photo has the same name with another extension, the watcher builds the set again from that one when it starts.
  3. Purge Next's image cache with `web` stopped, then start the stack. The deletes and the purge run inside the containers, since the files belong to the containers' user and a host user's `rm` can fail.
  4. Check that `/api/photos` no longer lists the photo. Once a catalog revision is active, `/media` keeps serving it until a publish leaves it out, as the next item describes.

  ```bash
  docker compose -f docker-compose.prod.yml stop image-watcher
  # Delete the photo, then, with its name for <name>:
  docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher sh -c 'cd /app/public/assets/photos && rm -f -- thumbnails/"$1".webp medium/"$1".webp optimized/"$1".webp thumbnails-avif/"$1".avif medium-avif/"$1".avif optimized-avif/"$1".avif lqip/"$1".txt cache/set-sources/"$1".json' sh '<name>'
  docker compose -f docker-compose.prod.yml stop web
  docker compose -f docker-compose.prod.yml run --rm --no-deps web sh -c 'rm -rf /app/.next/cache/images/*'
  docker compose -f docker-compose.prod.yml start web image-watcher
  ```
- **Take a photo down after the launch**, once a catalog revision is active. Do the steps above too, since its legacy derivatives stay reachable at their URLs until the legacy URLs close.
  1. Take the photo out of every series that lists it, then publish. Run each command with the same `run --rm --no-deps image-watcher` form as the commands above, as `node dist/scripts/photos.mjs <command>`. `list` shows the series that list the photo. In each one, `sequence remove <seriesId> <photoId>` takes it out, and a publish then needs these too:
     - A published series needs a cover. If the photo was the cover, the remove clears it, so pick another with `sequence cover <seriesId> <otherPhotoId>`.
     - If it was the opening photograph, the remove clears that too, and the series then has no opening photograph. Pick another with `sequence opening <seriesId> <otherPhotoId>` if you want one. A hand edit has to change or drop `openingPhotoId` itself.
     - A chapter that starts on it moves to the next photograph. If it's the chapter's only one, the remove refuses, so remove the chapter first with `sequence chapter remove <seriesId> <chapterId>`.
     - A published series needs a photograph. If it's the series' only one, hide the series instead: set its `visibility` to `"hidden"` with `edit <seriesId> --file <path> --expect-version <N>`, on a host copy as "Curating the catalog" below shows.
     - A hidden series can't stay featured, and at least one featured series has to stay published. If you hid a featured series, list the ones left with `series featured <seriesId>...`.

     Then run `validate`, which names each record and field a publish would stop on, and publish with `publish --actor <name>`.
  2. Check that `GET /api/ready` answers `"state":"ok"` with the `revisionId` that publish printed. `degraded` means `web` couldn't read the new revision and still serves the one before, the photo included.
  3. Purge the photo's `/media` URLs from any CDN in front of the site. `/media` sends `max-age=31536000, immutable`, so a browser that loaded the photo can keep showing it for up to a year.

  If the publish stops on errors in other records, the photo stays public until they're fixed. `validate` lists them. As a last resort, delete its sets, `assets/<photoId>/` in the data root, inside `image-watcher`. `/media` then answers 404 for them, and its page shows a broken image until a publish leaves the photo out.
- **List legacy derivatives whose photo is gone**, such as a deleted photo's or a renamed photo's earlier names. It prints each base name in `optimized/` that no photo in the library's top folder has. Only the extensions the watcher builds from count, in any case (`.jpg`, `.jpeg`, `.png`, `.webp`), so a sidecar such as `IMG_1.xmp` left behind doesn't hide a deleted photo's old images:

  ```bash
  docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher sh -c 'cd /app/public/assets/photos && for f in optimized/*.webp; do n=${f#optimized/}; n=${n%.webp}; found=; for s in "$n".*; do case "$s" in *.[jJ][pP][gG]|*.[jJ][pP][eE][gG]|*.[pP][nN][gG]|*.[wW][eE][bB][pP]) found=1;; esac; done; [ -n "$found" ] || echo "$n"; done'
  ```
- **Regenerate everything** locally with `npm run images:process -- --force`. The production image has no tsx or npm scripts, so there, run the bundled watcher with `--force`, and stop `image-watcher` first so the two never write at once. Photos with an EXIF orientation tag need none of this after an upgrade: the watcher rebuilds them by itself at its first start, as [docs/releasing.md](docs/releasing.md) describes for slice A of #10.

  ```bash
  docker compose -f docker-compose.prod.yml stop image-watcher
  docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/imageWatcher.mjs --once --force
  docker compose -f docker-compose.prod.yml start image-watcher
  ```
- **Restore the library folder** if it was deleted. The watcher exits 1 when its folder disappears, and since Compose no longer creates a missing photos folder, neither container can start until it's back. Stop the stack, copy the folder back into place rather than moving it with `mv`, then start the stack.
- **Preview stable photo IDs** with `npm run photos:migrate -- --dry-run`. It proposes an ID for every photo and writes only a plan and a report, to `identity/migration/` in the data root or to `--out <dir>`. Applying the plan with `-- --apply --plan <file>` initializes the data root, and from then on the watcher keeps the IDs current, nested folders included, and builds each photo's `/media` set. Home and the Gallery list photos from the registry it writes, so they stay empty until the plan is applied. In production, follow the runbook in [docs/data-root.md](docs/data-root.md), which backs up the library and the data root first and runs the same steps in the watcher container.
- **Check and publish the catalog** with `npm run photos -- validate`, which compiles the authored records in the data root and prints every problem without taking a lock or writing anything, so it also runs on a read-only data root, and `npm run photos -- publish --actor <name>`, which validates them again under a lock and makes the result the active revision. Add `--dry-run` to stop after validation. The first publish also needs `--confirm-launch`. From then on, `/api/photos` lists the active revision's photos at their `/media` URLs instead of the registry's, and `/media` serves only the sets the active revision holds, so don't publish in production before the launch. "Curating the catalog" below has the rest of the commands.

### Curating the catalog

The series, their order, and each photograph's description, title, and caption live in authored records under `authored/` in the data root. The `photos` commands below edit them, `validate` checks them, and `publish` makes them public as one catalog revision. Visitors see nothing until a publish. Locally, run a command as `npm run photos -- <command>`. In production, until the image has a service of its own for these commands, run them in `image-watcher`'s container, which mounts the data root read-write, as the data-root runbook does:

```bash
photos() { docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs "$@"; }
photos status
```

With an override, change `docker compose -f docker-compose.prod.yml` in the function, and in the other commands here, to the files the host's Compose loads, as [Production with Docker](#production-with-docker) says.

The commands:

- `status [--json]`: the data root, the revision the site serves and whether its publish finished, the last publish, the registry's counts, the records, how many photos no series lists or have no reviewed description, and the watcher's heartbeat.
- `list [--unassigned] [--json]`: each photo with its library path, capture date, series, description state, and the 400 px set it would publish on. `--unassigned` keeps the photos no series lists.
- `draft:init`: a record for every photo that has none, with no description and the asset revision its file is bound to, and `site.json` if it's missing. It never overwrites a record, so run it again after adding photos.
- `describe --import <file> [--dry-run]`: descriptions, decorative flags, titles, and captions for many photos from one file, below. `--dry-run` says what would change, takes no lock, and writes nothing.
- `sequence show | set | insert | move | remove | cover | opening | chapter add | chapter move | chapter remove`: a series' photographs, cover and its focal point, opening photograph, and chapters. `photos` with no command prints each form.
- `series order <seriesId>...` sets the Work order, and `series featured <seriesId>...` the featured series, which Home opens on once it reads the catalog (#4). `series featured --clear` features none, and a publish then stops on `refs.non-empty` until a published series is featured again.
- `edit <record>`: any other change to a record, below.
- `curation list | show | edit | approve | defer | dismiss | retry | reopen`: the draft inbox the watcher fills as photographs arrive, change, or go missing. `approve` places a new photograph in the draft, and nothing publishes until `publish`. `photos` with no command prints each form, and [docs/data-root.md](docs/data-root.md#curation-inbox) has the suggestion rules.
- `validate`, then `publish --actor <name>`, as above.
- `history` and `rollback`, below.

`status` to `series`, and `edit` below, exit 0 when they worked, 1 when they refused or the data root isn't ready or isn't set, 2 on a usage error, 3 while another command holds the authored records or when a record changed underneath it, and 4 on an I/O error. `validate` and `publish` keep slice B's codes: 0 when valid or published, 1 on validation errors, 2 on a usage error, 4 when a catalog file is damaged or an I/O error stops them, and 3 on any other stop, such as a data root that isn't ready or isn't set, a busy lock, or the first publish's launch stop. A flag given twice is refused, and an argument that starts with `-`, such as a chapter title, goes after `--`: `photos sequence chapter add <seriesId> --start <photoId> -- "-30 at dawn"`. Every `sequence` and `series` change takes `--expect-version <N>`, the version `sequence show` or the last change printed, so it stops if someone else changed the record in between.

The import file is CSV with a header row, or a JSON array of objects, with the columns `photoId` (required), `alt`, `decorative` (`true` or `false`), `title`, and `caption`. An empty cell leaves its field as it is, and an imported description counts as reviewed, so check it first. `decorative` `true` marks a photo decorative, and `false` with an empty `alt` takes the flag off, so the photo has no description and blocks a publish until it gets one. Any row the import can't apply, such as an unknown photo ID, stops the whole import before it writes anything, and a run that fails part way says how many records it wrote: running the same file again finishes it. The file has to be:

- UTF-8. In Excel, save as "CSV UTF-8": plain "CSV" and "CSV (Macintosh)" write another encoding, and the import names the first line it can't read.
- A regular file of at most 5 MiB.
- Plain text: no control characters, no invisible format characters (bidi controls, zero-width spaces, soft hyphens, tag characters, and the rest of Unicode's Cf), no private-use or unassigned code points, and no replacement characters. The import names the code point and the character's position. ZWJ and ZWNJ, the left-to-right and right-to-left marks, and emoji flags written with tags, such as England's, are fine. Chapter titles from `sequence chapter add` follow the same rules, with `title`'s 200-character limit.
- At most 1,000 characters of `alt`, 200 of `title`, and 2,000 of `caption`. Only `caption` takes a line break. The description rules still warn about alt text past 250 characters.

In JSON, a key given twice in one object keeps its last value. In production the command reads a path inside the container, so mount the file there, readable by the containers' user, for example:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps -v "$PWD/descriptions.csv:/tmp/descriptions.csv:ro" image-watcher node dist/scripts/photos.mjs describe --import /tmp/descriptions.csv --dry-run
```

`edit (<photoId> | <seriesId> | site) [--file <path> --expect-version <N>]` covers what the commands above don't: creating a series, its slug, title, statements, and visibility, and a photo's focal point, crop, credit, and location. It opens the record's newest version in `$VISUAL` or `$EDITOR`, without the fields the commands manage (`schemaVersion`, `version`, `baseRevisionId`, and the site's `baseSeriesOrder`), checks your edit against the record's schema and its text against the import's rules and limits (statements take up to 2,000 characters and a short statement 500), and saves it as the next version. A series with no record opens as a draft, so `photos edit ser_<name>` is how a new series starts. Its ID is `ser_` and then a lowercase letter or digit and 1 to 62 more lowercase letters, digits, `-`, or `_`. A published series also needs a title, a statement, a short statement, a photograph, and a cover before a publish takes it. If the record changed while the editor was open, or the edit can't be saved, the command keeps your edit in `edits/` in the data root and prints the command that saves it once fixed, `edit <id> --file <path> --expect-version <N>`, where N is the version the edit started from. If the record has moved past N, that command exits 3 and names the newer version: merge your edit into it and run it again with that number. Run `photos validate` afterwards.

Opening an editor is for local use. In production, edit a host copy and save it with `--file`:

```bash
# As root, keeping the data root's owner, as docs/data-root.md's hand edits do. Say the newest version is v4.json.
root=portfolio-data
owner="$(sudo stat -c %u:%g "$root")"   # stat -f %u:%g on macOS
sudo test -e "$root/edits" || sudo install -d -o "${owner%:*}" -g "${owner#*:}" -m 700 "$root/edits"
sudo cp -n -p "$root/authored/series/<seriesId>/v4.json" "$root/edits/<seriesId>.json"
sudoedit "$root/edits/<seriesId>.json"
photos edit <seriesId> --file /data/portfolio/edits/<seriesId>.json --expect-version 4
```

The copy can keep its `stamp` and managed fields: `edit` ignores them. `--file` needs `--expect-version` whenever the record exists, so a copy can't replace a version written after it was made.

Each record is a folder of versions under `authored/`: `site/`, `series/<seriesId>/`, and `photos/<photoId>/`, each holding `v1.json`, `v2.json`, and so on, where the highest number is the record. Edit a record only through `photos edit`, or by copying its newest version to the next number and editing the copy, as [docs/data-root.md](docs/data-root.md) describes:

- Only while no `photos` command runs. The commands hold a lock while they write, and an editor doesn't take it.
- Never edit a version in place. A command that reads an edited newest version refuses it and names the copy that keeps the edit.
- Never copy or edit the active pointer, `catalog/active/`. Only `photos publish` and `photos rollback` move it.
- Copy and edit as root, keeping the owner: `sudo cp -n -p` keeps the owner and mode of the version it copies, and `sudoedit` writes back into the same file. A copy root owns can't be read by the app. If one already is, give it the owner of the version it came from with `chown --reference`, or `chown -R 1001:1001 ./portfolio-data/authored`, the uid `docker-compose.prod.yml` runs the app as.

The first publish replaces the legacy Home and Gallery, so it stops and prints what it would change, with a checklist, until it's run with `--confirm-launch`. Run it again with the `--confirm-launch --expect <candidateId>` it prints, so it publishes exactly the candidate you checked. Before that:

- The cutover milestone has shipped: Home, Work, the series pages, and the Viewer read the catalog (#4, #3, #5, #7), and #15's 15-1 and 15-2 are in, so a rollback works.
- Viewer hardening (#9) is recommended first.
- A preview looks right. Copy the data root and the library, publish the copy with `PHOTOGRAPHY_DATA_DIR` pointing at it, and serve it on another port bound to `127.0.0.1`. It's the copy's first publish, so it needs `--confirm-launch` too: check that the command names the copy before you type it.
  - On a source checkout, run `npm run build`, copy `public` into `.next/standalone/public` and `.next/static` into `.next/standalone/.next/static` as the Dockerfile does, and start `node .next/standalone/server.js` with `HOSTNAME=127.0.0.1`, `PORT=3001`, and `PHOTOGRAPHY_DATA_DIR` and `PHOTOGRAPHY_LIBRARY_DIR` set to the copies' absolute paths, since `server.js` changes to its own folder. Not `npx next start`.
  - On a host that runs only the image, which has no npx or tsx, use a separate container, never the compose services. `image-watcher` mounts the real data root, so a `publish --confirm-launch` there launches production. Mount the data root copy at `/data/preview` with `-e PHOTOGRAPHY_DATA_DIR=/data/preview`, mount the library copy at `/app/public/assets/photos`, and publish only `127.0.0.1:3001:3000`. Publish the copy in that same kind of container, with `node dist/scripts/photos.mjs publish`.

#### History and rollback

Every publish and rollback adds an activation record under `catalog/activations/`. Nothing rewrites a revision file, and a record changes only once, from pending to committed or set aside. `photos history` lists them, oldest first, by their sequence number rather than their time, since the containers' clocks can disagree. Each row has the revision number and ID, publish or rollback, who ran it and why, when, the validation result, and what that revision changed against the one it was compiled on. The live one says `LIVE`. One that never moved the active pointer, because a command crashed or lost its lock, says interrupted, and the next publish or rollback sets it aside. It takes no lock and writes nothing.

`photos rollback --to <number | revisionId> --reason <text>` makes a revision that was live before live again, without rebuilding any image:

```bash
photos history
photos rollback --to 3 --reason "revert the caption change" --actor <name>
```

- The target is a revision number or ID from `history`, and only one that was live before. The rollback is a new activation that keeps the target's number, so `history` shows revision 3 live again from a later row. No rollback goes back to the legacy Home and Gallery, and right after the launch there is no earlier revision to go to, so [docs/releasing.md](docs/releasing.md#after-the-catalog-launch) says how to go back then.
- It runs every rule on the stored revision first. An integrity error stops it, such as a derivative that is missing or has the wrong size, or a privacy rule: a rollback never brings back a path, a source file's name, or GPS, serial, or owner fields. Editorial errors, today the accent color's format and contrast, print with the plan and don't stop it, and the activation records them.
- It prints what the target brings back, removes, and changes against the live revision, by series and photo. A rollback can bring back a photo a later publish took out on purpose, so read the list. If the live revision's file is damaged or missing, it says so and lists everything the target publishes instead, since moving off a broken revision is what a rollback is for. The working layer can't be compared with a revision that can't be read, so after such a rollback every field that differs from the target becomes a conflict to settle before the next publish, even one you never touched. The rollback says how many it raised and lists them. Then it asks you to type `yes`. Where there is no terminal to ask in, run it again with `--yes --expect-active <revisionId>`, the live revision the list was made against, as it prints. `--yes` works only with `--expect-active`, and either way the rollback stops, changing nothing, if another revision went live in between.
- The actor is `--actor` or `PHOTOS_ACTOR`, and one is required: the container's user is always `nextjs`.
- It waits up to 30 seconds for a publish or another rollback that holds the catalog lock, then names the holder and when its lease runs out. It takes over a lease only once that lease has expired, and records the takeover on the activation. No flag breaks a live lock.
- Afterwards it moves the working layer onto the target, as a publish does. After `photos rollback`, the draft matches the target, apart from edits never published, which stay. A field the rolled-away revision published goes back to the target's value, and a series only it published goes hidden and keeps its text and photos. A field changed on both sides becomes a conflict to settle before the next publish. If the working layer is busy, or the command stops after the pointer moved, running the same rollback again finishes the job, and so does the next publish. A rollback to the revision that is already live changes nothing visitors see, so it asks nothing, and only records an interrupted activation and rebases the working layer if a crash left either undone.

`history` exits 0, 3 when the data root isn't ready or isn't set, and 4 when a catalog file is damaged or can't be read. `rollback` exits 0 when rolled back or when the target is already live, 1 when the target was never live or a rule stops it, 2 on a usage error, 4 when a catalog file is damaged or an I/O error stops it, and 3 on any other stop: no confirmation, another revision live first, a busy lock, or a data root that isn't ready.

In production both run in `image-watcher`'s container like the other commands. `docker compose run` gives the command a terminal, so the `photos` function above can answer the confirmation. In a script, add `-T` and confirm with `--yes --expect-active`:

```bash
docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/photos.mjs history
docker compose -f docker-compose.prod.yml run --rm --no-deps -T -e PHOTOS_ACTOR=<name> image-watcher node dist/scripts/photos.mjs rollback --to 3 --reason "revert the caption change" --yes --expect-active <revisionId>
```

#### Cleanup

`photos gc` plans the cleanup the data root's [retention rules](docs/data-root.md#retention-and-cleanup) allow: staging folders a killed derivative build left, and candidates that never became a revision, once each has gone unchanged for more than 7 days. It lists each path with its class, the rule that allows it, and its size, prints a plan digest, and deletes nothing. `photos gc --apply <planDigest>` deletes exactly that plan, and stops without deleting anything if the plan changed since. It never deletes an asset, a revision, an activation, a record, or anything in `edits/`.

### Supported Formats
- JPEG (.jpg, .jpeg)
- PNG (.png)
- WebP (.webp)

## ⚙️ Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SITE_URL` | The site's public origin, like `https://keyurgolani.photography`, for share links and the share image URL. Read on every request, never at build time. Unset or invalid, share links point at `http://localhost:3000`, and a production server logs one warning at startup that names the reason, never the value. | none |
| `PHOTOGRAPHY_LIBRARY_DIR` | Photo library folder for the watcher and `/api/photos`. The site serves photos only from `public/assets/photos`, so leave it unset outside tests. | `public/assets/photos` |
| `PHOTOGRAPHY_DATA_DIR` | Private data root for photo identity state and the `/media` sets. It must sit outside `public/` and the library, on a filesystem that supports hard links (not exFAT or FAT), since each version of its documents is written with `link()`. The watcher's identity step runs only once `photos:migrate --apply` has initialized it, and until then the watcher logs why once. Outside production it defaults to `./portfolio-data`, so `npm run images:watch` and the dev compose watch with identity on (every depth, polled) even when it's unset. In production nothing changes until it's set. Both compose files set it to `/data/portfolio` and mount `./portfolio-data` there. To edit a document there by hand, copy its newest version to the next number without changing its owner or mode: from a shell in the watcher's image when it runs in the containers, or as root with `sudo cp -n -p` otherwise. Edit the copy, and do it only while no command runs. Never edit a version in place. [`docs/data-root.md`](docs/data-root.md) has the steps. | `portfolio-data`, none in production |

The Home slideshow interval isn't configurable. It's `HOME_AUTO_ADVANCE_MS` (12000 ms) in `components/home/homePlayback.ts`.

Neither is how long Home's chrome stays up after the last activity. It's `HOME_CHROME_IDLE_MS` (4000 ms) in `components/home/homeChromeConfig.ts`.

### Docker Configuration

The production setup uses two containers, which both mount the photos folder and the data root, `./portfolio-data`, and never create either one:
- **web** - Next.js application server. Its healthcheck calls `/api/health`, which answers 200 with the data root's state. `/api/ready` says whether the photos can be served, and from which catalog revision, and answers 503 when they can't, such as before `photos:migrate --apply` has written the registry.
- **image-watcher** - Background photo processor, run from the bundled `dist/scripts/imageWatcher.mjs`. Its healthcheck passes while the heartbeat it writes to the data root every 30 s is under 120 s old.

A third, **curator**, is off unless you start it by name. It serves the private curation pages on the host's `127.0.0.1:3001` only, and from another machine you reach it through an SSH tunnel, `ssh -L 3001:127.0.0.1:3001 <host>`, which is its authentication. [docs/curator.md](docs/curator.md) covers who can reach it, turning it on and off, and its settings.

| Variable | Description | Default |
|----------|-------------|---------|
| `PHOTOGRAPHY_IMAGE_TAG` | Release tag both containers run, such as `vX.Y.Z`. Set it in the `.env` next to `docker-compose.prod.yml`. | None. Compose refuses to start without it. |

See `docker-compose.prod.yml` for full configuration.

## 🎨 Customization

### Theme Colors
Edit CSS variables in `app/globals.css`:
```css
:root {
    --background-color: #FAFAFA;
    --primary-color: #121212;
    /* ... */
}

[data-theme="dark"] {
    --background-color: #050505;
    --primary-color: #F0F0F0;
    /* ... */
}
```

### Gallery Layout
Modify the grid in `components/Gallery.tsx`:
- Column count: `grid-cols-4 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12`
- Row height: `auto-rows-[50px]`

## 📦 Tech Stack

- **Framework:** Next.js 16 (App Router)
- **Language:** TypeScript
- **Styling:** Tailwind CSS
- **Animations:** Framer Motion
- **Images:** Sharp, yet-another-react-lightbox
- **Icons:** Lucide React
- **Container:** Docker

## 📄 License

This project is open source and available under the [MIT License](LICENSE).

## 🙏 Acknowledgments

- [Next.js](https://nextjs.org/) - The React Framework
- [Sharp](https://sharp.pixelplumbing.com/) - High performance image processing
- [Framer Motion](https://www.framer.com/motion/) - Production-ready animations
- [Tailwind CSS](https://tailwindcss.com/) - Utility-first CSS framework

---

Made with ❤️ by [Keyur Golani](https://github.com/keyurgolani)