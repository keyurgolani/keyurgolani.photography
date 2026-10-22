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
  <img src="docs/screenshots/about.png" alt="About page with social profiles" width="49%" />
</p>

<p align="center"><em>Immersive hero carousel, masonry gallery, and lightbox viewer.</em><br/>
👉 <strong><a href="SHOWCASE.md">See the full visual showcase »</a></strong></p>

## ✨ Features

### 🎨 Design
- **Glassmorphism UI** - Modern frosted glass effects with backdrop blur
- **Dark/Light Theme** - Seamless theme switching with system preference detection
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
- **Environment Variables** - Configurable carousel timing, UI timeouts, etc.

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

Open [http://localhost:3000](http://localhost:3000) to view the site. The Gallery lists the photos the migration recorded in `./portfolio-data`, the data root the npm scripts use by default, so until it has run, `/api/photos` answers 503 and the Gallery is empty. `npm run dev` alone builds no derivatives, and the Gallery lists a photo only once all seven of its derivatives exist, so it also stays empty until the watcher has run. `npm run images:process` builds them once and exits.

### Development with Docker

`docker-compose.yml` runs `next dev` and the photo watcher against your checkout:

```bash
docker compose up
```

After a dependency change, rebuild with `docker compose up --build -V`. Without `-V`, the anonymous `node_modules` volume keeps the old install. Both containers use `./portfolio-data` in your checkout as the data root, the same folder the npm scripts use by default.

### Production with Docker

Both containers run one pinned release tag. Set it in a `.env` next to `docker-compose.prod.yml`:

```bash
PHOTOGRAPHY_IMAGE_TAG=vX.Y.Z
```

Both also mount the private data root, `./portfolio-data`, which has to exist and belong to uid 1001 before the first start, like the photos folder:

```bash
mkdir -p portfolio-data
sudo chown -R 1001:1001 public/assets/photos portfolio-data
```

[docs/data-root.md](docs/data-root.md) covers what it holds, backing it up with the library, restoring it, and the one-time migration that gives every photo its ID.

Then pull and start:

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

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
│   ├── HeroCarousel.tsx   # Hero image carousel
│   ├── ThemeToggle.tsx    # Dark/light theme switcher
│   └── LoadingAnimation.tsx # Loading screen animation
├── utils/                 # Utility functions
│   ├── imageOptimizer.ts  # Sharp-based image processing
│   └── watcherHandlers.ts # Watcher event handlers and job queue
├── scripts/               # Background scripts, bundled into dist/scripts for the image
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
3. **Gallery updates** on the next page load once the watcher has recorded the photo in the data root and written all seven of its derivatives, and the original file is never served. The production server serves only the `public/` files that existed when it started, so restart `web` for photos added since to load there.

### Replacing and Removing Photos
- **Replace** a photo by saving over it under the same name. The watcher regenerates its derivatives from the new file and swaps them in only once all seven are written, so a failed run keeps the old ones. Visitors can still see the old version for a while: `/_next/image` can serve its copy for up to a day, and a browser that cached it under the old `immutable` header may keep it for up to a year.
- **Accepted risk:** a different photo saved under a removed photo's name, with an older modification time, shows the old images until you `touch` it or run `--force`. Copy tools that keep modification times, such as `cp -p` and `rsync -a`, do this. A photo that takes over a set another photo built, such as `IMG_1.jpg` added next to `IMG_1.png`, doesn't have this problem. Each set records the source it was built from, so the watcher rebuilds it when the file arrives, or at its next start if it was stopped.
- **Delete** a photo to hide it from the gallery. `/api/photos` stops listing it once the watcher's next pass records it missing. Nothing deletes its derivative files, which stay reachable at their URLs, so restoring the file brings the photo back with nothing to rebuild. To take it offline, follow the next item.
- **Take a photo down** with the watcher stopped, so a job already running can't write its derivatives back:
  1. Stop `image-watcher`, then delete the photo.
  2. Delete its seven derivatives and `cache/set-sources/<name>.json`, the record of which source its set was built from, where `<name>` is the photo's file name without its extension, such as `landscape`. Do the same for each earlier name the photo had. If another photo has the same name with another extension, the watcher builds the set again from that one when it starts.
  3. Purge Next's image cache with `web` stopped, then start the stack. The deletes and the purge run inside the containers, since the files belong to the containers' user and a host user's `rm` can fail.
  4. Check that `/api/photos` no longer lists the photo. Once a catalog revision is active, it keeps serving the photo from `/media` until you publish one without it.

  ```bash
  docker compose -f docker-compose.prod.yml stop image-watcher
  # Delete the photo, then, with its name for <name>:
  docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher sh -c 'cd /app/public/assets/photos && rm -f -- thumbnails/"$1".webp medium/"$1".webp optimized/"$1".webp thumbnails-avif/"$1".avif medium-avif/"$1".avif optimized-avif/"$1".avif lqip/"$1".txt cache/set-sources/"$1".json' sh '<name>'
  docker compose -f docker-compose.prod.yml stop web
  docker compose -f docker-compose.prod.yml run --rm --no-deps web sh -c 'rm -rf /app/.next/cache/images/*'
  docker compose -f docker-compose.prod.yml start web image-watcher
  ```
- **Regenerate everything** with `npm run images:process -- --force`. In production, stop `image-watcher` first so the two never write at once:

  ```bash
  docker compose -f docker-compose.prod.yml stop image-watcher
  docker compose -f docker-compose.prod.yml run --rm --no-deps image-watcher node dist/scripts/imageWatcher.mjs --once --force
  docker compose -f docker-compose.prod.yml start image-watcher
  ```
- **Restore the library folder** if it was deleted. The watcher exits 1 when its folder disappears, and since Compose no longer creates a missing photos folder, neither container can start until it's back. Stop the stack, copy the folder back into place rather than moving it with `mv`, then start the stack.
- **Preview stable photo IDs** with `npm run photos:migrate -- --dry-run`. It proposes an ID for every photo and writes only a plan and a report, to `identity/migration/` in the data root or to `--out <dir>`. Applying the plan with `-- --apply --plan <file>` initializes the data root, and from then on the watcher keeps the IDs current, nested folders included, and builds each photo's `/media` set. Home and the Gallery list photos from the registry it writes, so they stay empty until the plan is applied. In production, follow the runbook in [docs/data-root.md](docs/data-root.md), which backs up the library and the data root first and runs the same steps in the watcher container.
- **Check and publish the catalog** with `npm run photos -- validate`, which compiles the authored records in the data root and prints every problem without writing anything, and `npm run photos -- publish --actor <name>`, which validates them again under a lock and makes the result the active revision. Add `--dry-run` to stop after validation. The first publish also needs `--confirm-launch`. From then on, `/api/photos` lists the active revision's photos at their `/media` URLs instead of the registry's, and `/media` serves only the sets the active revision holds, so don't publish in production before the launch.

### Supported Formats
- JPEG (.jpg, .jpeg)
- PNG (.png)
- WebP (.webp)

## ⚙️ Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NEXT_PUBLIC_CAROUSEL_INTERVAL` | Hero carousel slide duration (ms) | 12000 |
| `NEXT_PUBLIC_UI_AUTO_HIDE_TIMEOUT` | UI auto-hide timeout on home page (ms) | 3000 |
| `PHOTOGRAPHY_LIBRARY_DIR` | Photo library folder for the watcher and `/api/photos`. The site serves photos only from `public/assets/photos`, so leave it unset outside tests. | `public/assets/photos` |
| `PHOTOGRAPHY_DATA_DIR` | Private data root for photo identity state and the `/media` sets. It must sit outside `public/` and the library. The watcher's identity step runs only once `photos:migrate --apply` has initialized it, and until then the watcher logs why once. Both compose files set it to `/data/portfolio` and mount `./portfolio-data` there. | `portfolio-data`, none in production |

### Docker Configuration

The production setup uses two containers, which both mount the photos folder and the data root, `./portfolio-data`, and never create either one:
- **web** - Next.js application server. Its healthcheck calls `/api/health`, which answers 200 with the data root's state. `/api/ready` says whether the photos can be served, and from which catalog revision, and answers 503 when they can't, such as before `photos:migrate --apply` has written the registry.
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