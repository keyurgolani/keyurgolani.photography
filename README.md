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
- **ISR Caching** - Incremental Static Regeneration for fast API responses
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

# Start development server
npm run dev

# In a second terminal, build the photos' derivatives, then keep watching for new ones
npm run images:watch
```

Open [http://localhost:3000](http://localhost:3000) to view the site. `npm run dev` and `npm start` listen on `127.0.0.1` only. `npm run dev` alone builds no derivatives, and the Gallery lists a photo only once all seven of its derivatives exist, so it stays empty until the watcher has run. `npm run images:process` builds them once and exits.

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

[docs/releasing.md](docs/releasing.md) covers cutting a release, deploying, rollback, and telling what's running.

## 📁 Project Structure

```
├── app/                    # Next.js App Router pages
│   ├── api/               # API routes: the photo list and health
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
│   ├── imageCleanup.ts    # Reviews and deletes leftover derivatives
│   ├── imageWatcher.ts    # File watcher for new photos
│   ├── photos.ts          # Photo ID migration and identity commands
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
3. **Gallery updates** on the next page load once all seven of a photo's derivatives exist, and the original file is never served. The production server serves only the `public/` files that existed when it started, so restart `web` for photos added since to load there.

### Replacing and Removing Photos
- **Replace** a photo by saving over it under the same name. The watcher regenerates its derivatives from the new file and swaps them in only once all seven are written, so a failed run keeps the old ones. Visitors can still see the old version for a while: `/_next/image` can serve its copy for up to a day, and a browser that cached it under the old `immutable` header may keep it for up to a year.
- **Accepted risk:** a different photo saved under a removed photo's name, with an older modification time, shows the old images until you `touch` it or run `--force`. Copy tools that keep modification times, such as `cp -p` and `rsync -a`, do this. With the watcher stopped, run `images:cleanup` before reusing a name. A photo that takes over a set another photo built, such as `IMG_1.jpg` added next to `IMG_1.png`, doesn't have this problem. Each set records the source it was built from, so the watcher rebuilds it when the file arrives, or at its next start if it was stopped.
- **Delete** a photo to hide it from the gallery. Its derivative files stay reachable at their URLs until `images:cleanup` deletes them. Restoring the file brings the photo back in the gallery after `web` restarts, since Next serves only the `public/` files that existed when it started.
- **Review leftovers** with `npm run images:cleanup`. It lists each derivative no photo needs anymore, and the watcher's record of which source that set was built from, with the reason, and prints a plan hash. Re-run it with `-- --apply --plan <hash>` to delete exactly that list. It refuses if the list changed since the dry run. In production, run both steps in the watcher container, which has the bundled script instead of tsx:

  ```bash
  docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/imageCleanup.mjs
  docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/imageCleanup.mjs --apply --plan <hash>
  ```
- **Take a photo down** with the watcher stopped, so a job already running can't write its derivatives back:
  1. Stop `image-watcher`, then delete the photo.
  2. Run the full dry run. It also lists sets left under the photo's earlier names.
  3. Run it with `--only <name>`, where `<name>` is the photo's exact name such as `landscape`, then apply that plan. Do the same for each earlier name. If either step exits 1 and names a folder it couldn't look in, remove the photo's files from that folder by hand.
  4. Purge Next's image cache with `web` stopped, then start the stack. The purge runs inside the `web` image, since the cache files belong to its uid 1001 and a host user's `rm` can fail.
  5. Wait about two minutes, then check that `/api/photos` no longer lists the photo. Its cached list survives a restart until it revalidates.

  ```bash
  docker compose -f docker-compose.prod.yml stop image-watcher
  # Delete the photo, then:
  docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/imageCleanup.mjs
  docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/imageCleanup.mjs --only <name>
  docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/imageCleanup.mjs --only <name> --apply --plan <hash>
  docker compose -f docker-compose.prod.yml stop web
  docker compose -f docker-compose.prod.yml run --rm --no-deps web sh -c 'rm -rf /app/.next/cache/images/*'
  docker compose -f docker-compose.prod.yml start web image-watcher
  ```
- **Regenerate everything** locally with `npm run images:process -- --force`. The production image has no tsx or npm scripts, so there, run the bundled watcher with `--force`, and stop `image-watcher` first so the two never write at once. Photos with an EXIF orientation tag need none of this after an upgrade: the watcher rebuilds them by itself at its first start, as [docs/releasing.md](docs/releasing.md) describes for slice A of #10.

  ```bash
  docker compose -f docker-compose.prod.yml stop image-watcher
  docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/imageWatcher.mjs --once --force
  docker compose -f docker-compose.prod.yml start image-watcher
  ```
- **Restore the library folder** if it was deleted. The watcher exits 1 when its folder disappears, and since Compose no longer creates a missing photos folder, neither container can start until it's back. Stop the stack, copy the folder back into place rather than moving it with `mv`, then start the stack.
- **Preview stable photo IDs** with `npm run photos:migrate -- --dry-run`. It proposes an ID for every photo and writes only a plan and a report, to `identity/migration/` in the data root or to `--out <dir>`. Applying the plan with `-- --apply --plan <file>` initializes the data root, and from then on the watcher keeps the IDs current, nested folders included, and builds each photo's `/media` set. Nothing on the site uses them yet. In production, follow the runbook in [docs/data-root.md](docs/data-root.md), which backs up the library and the data root first and runs the same steps in the watcher container.
- **Check and publish the catalog** with `npm run photos -- validate`, which compiles the authored records in the data root and prints every problem without taking a lock or writing anything, so it also runs on a read-only data root, and `npm run photos -- publish --actor <name>`, which validates them again under a lock and makes the result the active revision. Add `--dry-run` to stop after validation. The first publish also needs `--confirm-launch`. Nothing on the site reads the catalog yet, and once it does, the active revision replaces the legacy Home and Gallery, so don't publish in production before the launch.

### Supported Formats
- JPEG (.jpg, .jpeg)
- PNG (.png)
- WebP (.webp)

## ⚙️ Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SITE_URL` | The site's public origin, like `https://keyurgolani.photography`, for share links and the share image URL. Read on every request, never at build time. Unset or invalid, share links point at `http://localhost:3000`, and a production server logs one warning at startup that names the reason, never the value. | none |
| `PHOTOGRAPHY_LIBRARY_DIR` | Photo library folder for the watcher, `images:cleanup`, and `/api/photos`. The site serves photos only from `public/assets/photos`, so leave it unset outside tests. | `public/assets/photos` |
| `PHOTOGRAPHY_DATA_DIR` | Private data root for photo identity state and the `/media` sets. It must sit outside `public/` and the library, on a filesystem that supports hard links (not exFAT or FAT), since each version of its documents is written with `link()`. The watcher's identity step runs only once `photos:migrate --apply` has initialized it, and until then the watcher logs why once. Outside production it defaults to `./portfolio-data`, so `npm run images:watch` and the dev compose watch with identity on (every depth, polled) even when it's unset. In production nothing changes until it's set. Both compose files set it to `/data/portfolio` and mount `./portfolio-data` there. To edit a document there by hand, copy its newest version to the next number without changing its owner or mode: from a shell in the watcher's image when it runs in the containers, or as root with `sudo cp -n -p` otherwise. Edit the copy, and do it only while no command runs. Never edit a version in place. [`docs/data-root.md`](docs/data-root.md) has the steps. | `portfolio-data`, none in production |
| `PHOTOGRAPHY_MEDIA_ACCESS` | Who `/media` serves sets to: `deny` serves none, and `all` serves every set to anyone. Any other value denies. The web server reads it at each request. Leave it unset in production until the catalog decides which photos are public. | `deny` |

The Home slideshow interval isn't configurable. It's `HOME_AUTO_ADVANCE_MS` (12000 ms) in `components/home/homePlayback.ts`.

Neither is how long Home's chrome stays up after the last activity. It's `HOME_CHROME_IDLE_MS` (4000 ms) in `components/home/homeChromeConfig.ts`.

### Docker Configuration

The production setup uses two containers, which both mount the photos folder and the data root, `./portfolio-data`, and never create either one:
- **web** - Next.js application server. Its healthcheck calls `/api/health`, which answers 200 with the data root's state.
- **image-watcher** - Background photo processor, run from the bundled `dist/scripts/imageWatcher.mjs`. Its healthcheck passes while the heartbeat it writes to the data root every 30 s is under 120 s old.

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