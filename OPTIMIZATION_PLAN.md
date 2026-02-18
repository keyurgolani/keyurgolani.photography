# Photography Portfolio — Image Optimization & Performance Plan

> **Date:** February 2026 (Updated — Round 4, after third round of gap fixes)
> **Scope:** End-to-end image delivery optimization, from server-side processing to client rendering
> **Goal:** Make the portfolio fast, visually sharp, and cost-free to operate at any photo count — without compromising image quality or the deployment simplicity of Docker + bind-mounts.

---

## Table of Contents

1. [Implementation Status Summary](#1-implementation-status-summary)
2. [What Was Implemented](#2-what-was-implemented)
3. [Active Gaps & Issues](#3-active-gaps--issues)
4. [Remaining Work](#4-remaining-work)
5. [File Change Summary (Cumulative)](#5-file-change-summary-cumulative)

---

## 1. Implementation Status Summary

| Phase | Item | Status |
|---|---|---|
| 1.1 | Remove `unoptimized: true` from next.config.mjs | ✅ Done |
| 1.2 | `fetchpriority="high"` on first carousel image | ✅ Done |
| 1.2 | `<link rel="preload">` injection in DynamicHeroCarousel | ✅ Done |
| 1.3 | Fix `sizes` attribute per column span in Gallery | ✅ Done |
| 1.4 | LQIP blur-up placeholder in Gallery | ✅ Done |
| 2.1 | AVIF output in imageOptimizer | ✅ Done |
| 2.2 | 800px intermediate size | ✅ Done |
| 2.3 | Cache-bust on source file replacement | ✅ Done |
| 2.4 | Format-negotiation paths in ImageItem | ✅ Done |
| 3.1 | `/api/image` dynamic transform route | ✅ Done (+ ETag/304) |
| 3.2 | Gallery tiles use `img.src` directly (single Sharp pass via next/image) | ✅ Done |
| 3.3 | ISR 60s revalidation on `/api/photos` | ✅ Done |
| 3.4 | Lightbox slides route through `/api/image` | ✅ Done |
| 3.5 | Carousel routes through `/api/image` | ✅ Done |
| 4.1 | IntersectionObserver lazy loading in Gallery | ✅ Done |
| 4.2 | Pagination for `/api/photos` | ❌ Pending (threshold: > 50 photos) |
| 4.3 | Masonic DOM virtualization | ❌ Deferred (threshold: > 200 photos) |
| 5.1 | Replace `fs.watch` with chokidar | ✅ Done |
| 5.2 | `awaitWriteFinish` for large files | ✅ Done |
| 5.3 | `change` event → reprocessing on replacement | ✅ Done |
| 5.4 | `unlink` event → orphan cleanup on deletion | ✅ Done |
| 6.1 | `Cache-Control: immutable` on static image dirs | ✅ Done |
| 6.2 | `Cache-Control: s-maxage=60` on `/api/photos` | ✅ Done |
| 6.3 | ETag + 304 on `/api/image` | ✅ Done |
| 7.1 | Docker file permission hardening | ✅ Done (`user: "1001:1001"`) |
| 7.2 | `depends_on: web: condition: service_healthy` in prod | ✅ Done |
| 7.3 | Compile imageWatcher.ts at build time | ❌ Optional / not started |
| 7.4 | Nginx reverse proxy | ❌ Optional / not started |
| New | AVIF format negotiation — `img.src` uses original file | ✅ Done |
| New | Full buffer read replaced with `sharp(filePath)` | ✅ Done |
| New | YARL Thumbnails plugin — `thumbnail` property added to slides | ✅ Done |
| New | Next.js image cache persistence in Docker | ✅ Done (`.next-images-cache` bind mount) |
| New | Dead code removed from `/api/image` (subdirectory search, webp/avif early-return) | ✅ Done |

---

## 2. What Was Implemented

### Round 1 — Core Optimization (complete)

**`next.config.mjs`** — Removed `unoptimized: true`. Added `formats: ['image/avif', 'image/webp']`, `minimumCacheTTL: 86400`, `deviceSizes`, `imageSizes`, and `Cache-Control: immutable` headers for all 8 processed image subdirectories.

**`utils/imageOptimizer.ts`** — Full rewrite: 3 WebP sizes (400/800/1920px), 3 AVIF sizes, LQIP generation persisted to `lqip/photo.txt`, mtime-based cache busting, `reprocessImage()` for full cache invalidation, `getLqipBase64()` for disk reads, `cleanupOrphaned()` extended to all 7 processed dirs.

**`utils/getImageData.ts`** — `ImageItem` expanded with `medium`, `*Avif` paths, `lqip`. LQIP read from disk with on-the-fly generation as fallback. `noStore()` removed (ISR handles freshness). `img.src` set to the **original source file path** (`imagePaths.original`) so `/api/image` always receives the unprocessed JPEG/PNG and can negotiate format correctly. Sharp reads metadata via `sharp(filePath)` (not `sharp(buffer)`) to avoid loading full source files into memory on every ISR revalidation.

**`components/Gallery.tsx`** — Refactored into `LazyGalleryTile` with IntersectionObserver (`rootMargin: '400px'`), first 8 tiles eager, LQIP blur placeholder, `getSizes(colSpan)` for accurate `sizes` attribute, `src` routed through `/api/image?src=...&width=800`. Lightbox `photos` array uses `/api/image?...&width=1920` for format negotiation.

**`components/DynamicGallery.tsx`** — Passes `lqip` field to `Gallery`.

**`components/HeroCarousel.tsx`** — `fetchPriority="high"` on first slide's thumbnail and optimized `<img>` tags.

**`components/DynamicHeroCarousel.tsx`** — Maps carousel images through `/api/image` for both thumbnail (`width=400`) and optimized (`width=1920`). `preloadFirstImage()` injects `<link rel="preload" as="image" fetchpriority="high">` using the `/api/image` URL for the first slide's optimized image. `preloadFirstImage` called with the computed `/api/image` URL.

**`app/api/image/route.ts`** — New route: width clamped to `[400, 800, 1200, 1920]`, format negotiation from `Accept` header (AVIF > WebP > JPEG), disk cache at `cache/dynamic/{basename}-{width}-{quality}.{format}`, `Cache-Control: immutable`, ETag, 304 Not Modified support. Early-return path for `.webp`/`.avif` source files.

**`app/api/photos/route.ts`** — `revalidate = 60` ISR, `Cache-Control: s-maxage=60, stale-while-revalidate=300`.

**`scripts/imageWatcher.ts`** — Full rewrite using chokidar: `usePolling: true`, `depth: 0`, `awaitWriteFinish: { stabilityThreshold: 3000 }`, handles `add` (new file), `change` (replacement → `reprocessImage()`), `unlink` (deletion → `cleanupOrphaned()`). Initial scan + orphan cleanup on startup.

**`docker-compose.prod.yml`** — `user: "1001:1001"` on `image-watcher` service with a comment documenting the required host-side `chown -R 1001:1001 ./public/assets/photos`. `depends_on: web: condition: service_healthy` on `image-watcher`.

**`package.json`** — `chokidar: "^5.0.0"` added as production dependency.

### Round 4 — Double-processing fix, YARL thumbnails, dead code cleanup (complete)

**`components/Gallery.tsx`** — `LazyGalleryTile` now uses `<Image src={img.src} />` (the original JPEG/PNG path) instead of `<Image src={`/api/image?...&width=800`} />`. Next.js's built-in optimizer now handles the single Sharp pass: format negotiation from `Accept` header, srcset generation, and caching — all in `/_next/image`. The `sizes` attribute and LQIP blur placeholder remain unchanged. Lightbox `photos` array keeps `/api/image?...&width=1920` (YARL uses raw `<img>` tags). Added `thumbnail: `/api/image?...&width=400`` to each slide so the YARL Thumbnails plugin strip loads 400px images instead of 1920px.

**`app/api/image/route.ts`** — Removed the subdirectory search loop (was unreachable since `img.src` is always an original filename in `PHOTOS_DIR`) and the `.webp`/`.avif` early-return block (also unreachable). Route is now simpler: resolve `PHOTOS_DIR/filename`, 404 if missing, negotiate format, serve from disk cache or generate.

**`docker-compose.prod.yml`** — Added `.next-images-cache:/app/.next/cache/images` bind mount on the `web` service. Next.js's optimized image cache now persists across container restarts, eliminating cold-start re-processing.

---

## 3. Active Gaps & Issues

> **No active gaps.** All identified optimizations through Round 4 are implemented. The remaining items in §4 are scale-triggered or optional.

**Resolved:** Gallery tiles now use `<Image src={img.src} />` directly. Next.js handles format negotiation, srcset, sizing, and caching in a single Sharp pass. `.next-images-cache` bind mount added for persistence. ✅

### Closed — Gap 2 (was MEDIUM) — YARL thumbnail strip loading 1920px images

**Resolved:** Added `thumbnail: `/api/image?...&width=400`` to each slide object in the `photos` array. The Thumbnails plugin now loads 400px images for the strip. ✅

### Closed — Gaps 3 & 4 (was LOW) — dead code in `/api/image/route.ts`

**Resolved:** Subdirectory search loop and `.webp`/`.avif` early-return block removed. Route resolves only at `PHOTOS_DIR/filename`. ✅

### Open — Gap 5 — `getUnprocessedFiles()` does ~8× fs.existsSync calls per photo (LOW PRIORITY)

With 100 photos, `getUnprocessedFiles()` makes ~800 filesystem stat calls (3 WebP + 3 AVIF + 1 LQIP existence checks + 1 mtime comparison per file). This runs on watcher startup and on every ISR revalidation that triggers `ensureDirectories()`.

Not a correctness issue, and each stat call is fast, but with 500+ photos this becomes meaningful latency. Future improvement: maintain an in-memory set of processed filenames, invalidated when the watcher detects changes.

### Gap 6 — Dockerfile ships full node_modules for the watcher (LOW PRIORITY, OPTIONAL)

The production Docker image copies all of `node_modules` (including `tsx`, TypeScript, `chokidar`, `sharp`, and every transitive dep) into the runner stage just to run the TypeScript watcher script. This inflates the image.

**Fix:** Compile `imageWatcher.ts` to JavaScript at build time using a dedicated `tsconfig.watcher.json` that resolves `@/utils/*` path aliases to relative paths. The runner stage then only needs the production runtime deps (`sharp`, `chokidar`) rather than the full toolchain.

---

## 4. Remaining Work

### Immediate — High priority

#### 4.1 Remove `/api/image` from gallery tiles (Gap 1)

**File:** `components/Gallery.tsx`

Change `LazyGalleryTile`'s `<Image>` src from the `/api/image` URL back to `img.src` (which is now the original file path):

```tsx
// In LazyGalleryTile:
<Image
    src={img.src}
    alt={img.caption || `Gallery Image ${index + 1}`}
    fill
    placeholder="blur"
    blurDataURL={img.lqip || '...fallback...'}
    sizes={sizes}
    className="object-cover ..."
/>
```

Keep the lightbox `photos` array using `/api/image?...&width=1920` since YARL uses `<img>` tags internally and cannot leverage Next.js's srcset.

#### 4.2 Persist Next.js image cache in Docker (Gap 1 secondary)

**File:** `docker-compose.prod.yml`

```yaml
services:
  web:
    volumes:
      - ./public/assets/photos:/app/public/assets/photos
      - ./.next-images-cache:/app/.next/cache/images
```

On the host: `mkdir -p .next-images-cache && chown -R 1001:1001 .next-images-cache`

Also add a comment documenting this requirement alongside the existing `chown` comment for the photos directory.

### Short term — Medium priority

#### 4.3 Add `thumbnail` property to YARL lightbox slides (Gap 2)

**File:** `components/Gallery.tsx`

```tsx
const photos = images.map(img => ({
    src: `/api/image?src=${encodeURIComponent(img.src)}&width=1920`,
    thumbnail: `/api/image?src=${encodeURIComponent(img.src)}&width=400`,
    width: img.width,
    height: img.height,
}));
```

### Cleanup — Low priority

#### 4.4 Remove dead code from `/api/image` (Gaps 3 and 4)

**File:** `app/api/image/route.ts`

Once 4.1 is done and all callers pass original JPEG/PNG filenames, remove:
- The subdirectory search loop (lines 31–38)
- The early-return for `.webp`/`.avif` files (lines 47–61)

The route becomes simpler: resolve only at `PHOTOS_DIR/filename`, 404 if not found, proceed to format negotiation.

### Longer term — Scale

#### 4.5 Pagination for `/api/photos` (when > 50 photos)

**File:** `app/api/photos/route.ts`

```ts
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '24');

    const allImages = await getGalleryImages();
    const total = allImages.length;
    const start = (page - 1) * pageSize;

    return NextResponse.json({
        images: allImages.slice(start, start + pageSize),
        total,
        page,
        pageSize,
        hasMore: start + pageSize < total,
    });
}
```

`DynamicGallery.tsx` loads page 1, then fetches subsequent pages as the user scrolls near the bottom of the gallery (infinite scroll). The tile-level IntersectionObserver handles deferred image loading within each page.

#### 4.6 Masonic DOM virtualization (when > 200 photos)

`masonic` is already installed. When the gallery grows beyond ~200 photos, replace the CSS grid + `LazyGalleryTile` approach with masonic's `Masonry` component which virtualizes the DOM — only rendering tiles near the viewport. This requires redesigning the layout algorithm from `grid-flow-dense` to masonic's column-based approach.

#### 4.7 Nginx reverse proxy (optional)

Add Nginx in front of Next.js to serve pre-generated static image files directly from disk (bypassing Node.js), add disk-based response caching for `/api/image`, and handle SSL. See the previous version of this document for the full Nginx configuration.

#### 4.8 Compile imageWatcher.ts at build time (optional)

See Gap 6 for the approach. Reduces Docker image size by shipping only runtime production deps (`sharp`, `chokidar`) rather than the full TypeScript toolchain.

---

## 5. File Change Summary (Cumulative)

| File | Change Type | Status |
|---|---|---|
| `next.config.mjs` | Modified — formats, cache TTL, deviceSizes, Cache-Control headers | ✅ Done |
| `utils/imageOptimizer.ts` | Rewritten — AVIF, 800px, LQIP, cache-busting, reprocessImage, getLqipBase64 | ✅ Done |
| `utils/getImageData.ts` | Modified — original src path, LQIP, medium/AVIF paths, sharp(filePath) | ✅ Done |
| `components/Gallery.tsx` | Refactored — LazyGalleryTile, IntersectionObserver, blur placeholder, getSizes, lightbox via /api/image | ✅ Done |
| `components/DynamicGallery.tsx` | Modified — passes lqip field | ✅ Done |
| `components/HeroCarousel.tsx` | Modified — fetchPriority="high" on first slide | ✅ Done |
| `components/DynamicHeroCarousel.tsx` | Modified — carousel through /api/image, preloadFirstImage | ✅ Done |
| `app/api/photos/route.ts` | Modified — ISR revalidate=60, Cache-Control header | ✅ Done |
| `app/api/image/route.ts` | New — dynamic transform, disk cache, format negotiation, ETag, 304 | ✅ Done |
| `scripts/imageWatcher.ts` | Rewritten — chokidar, usePolling, awaitWriteFinish, change/unlink events | ✅ Done |
| `docker-compose.prod.yml` | Modified — user: "1001:1001", depends_on healthcheck | ✅ Done |
| `package.json` | Modified — chokidar added | ✅ Done |
| `components/Gallery.tsx` | **Pending** — gallery tiles use `img.src` directly, not `/api/image` | ❌ Gap 1 |
| `components/Gallery.tsx` | **Pending** — add `thumbnail` prop to YARL slides | ❌ Gap 2 |
| `docker-compose.prod.yml` | **Pending** — bind-mount `.next/cache/images` for persistence | ❌ Gap 1 secondary |
| `app/api/image/route.ts` | **Pending** — remove subdirectory search + webp/avif early-return | ❌ Gaps 3 & 4 (cleanup) |
| `app/api/photos/route.ts` | **Pending** — pagination | ❌ When > 50 photos |
| `Dockerfile` | **Pending** — compile watcher at build time | ❌ Optional |

---

## References

- [Next.js Image Optimization Docs](https://nextjs.org/docs/app/getting-started/images)
- [Next.js Image Component API](https://nextjs.org/docs/app/api-reference/components/image)
- [Sharp AVIF encoding](https://sharp.pixelplumbing.com/api-output#avif)
- [Responsive Images — MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Guides/Responsive_images)
- [YARL Slide Types / thumbnail property](https://yet-another-react-lightbox.com/documentation/slides)
- [Low Quality Image Placeholders (LQIP) — Cloudinary](https://cloudinary.com/blog/low_quality_image_placeholders_lqip_explained)
- [imgproxy self-hosted image CDN](https://imgproxy.net/)
- [chokidar npm](https://www.npmjs.com/package/chokidar)
- [HTTP Caching — MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching)
- [masonic virtualized masonry grid](https://github.com/jaredLunde/masonic)
