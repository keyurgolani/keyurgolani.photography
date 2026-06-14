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
- **Dynamic Image API** - On-demand image resizing with disk caching
- **ISR Caching** - Incremental Static Regeneration for fast API responses
- **Docker Ready** - Production-optimized containerized deployment

### 🔧 Technical
- **Sharp Image Processing** - High-quality image optimization with AVIF support
- **Background Image Watcher** - Automatic processing of new photos
- **EXIF Extraction** - Automatic caption generation from photo metadata
- **Environment Variables** - Configurable carousel timing, UI timeouts, etc.

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ 
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
```

Open [http://localhost:3000](http://localhost:3000) to view the site.

### Production with Docker

```bash
# Build and run with Docker Compose
docker-compose -f docker-compose.prod.yml up -d

# Or use the pre-built image
docker pull ghcr.io/keyurgolani/keyurgolani.photography:latest
```

## 📁 Project Structure

```
├── app/                    # Next.js App Router pages
│   ├── api/               # API routes (photos, image optimization)
│   ├── gallery/           # Gallery page
│   ├── about/             # About page
│   └── page.tsx           # Home page
├── components/            # React components
│   ├── Gallery.tsx        # Masonry gallery grid
│   ├── HeroCarousel.tsx   # Hero image carousel
│   ├── ThemeToggle.tsx    # Dark/light theme switcher
│   └── LoadingAnimation.tsx # Loading screen animation
├── utils/                 # Utility functions
│   ├── getImageData.ts    # Image metadata extraction
│   └── imageOptimizer.ts  # Sharp-based image processing
├── scripts/               # Background scripts
│   └── imageWatcher.ts    # File watcher for new photos
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
3. **Gallery updates** automatically on next page load

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

### Docker Configuration

The production setup uses two containers:
- **web** - Next.js application server
- **image-watcher** - Background photo processor

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