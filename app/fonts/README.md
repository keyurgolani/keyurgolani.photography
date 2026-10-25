# Fonts

`app/fonts.ts` loads the two WOFF2 files through `next/font/local`, so the
site serves them from its own origin. Both families are under the SIL Open
Font License 1.1, whose text sits beside each family's files.

| File | What it is | Source | Version |
| --- | --- | --- | --- |
| `newsreader/newsreader-latin-wght-normal.woff2` | Newsreader, latin subset, variable weight 200 to 800, optical size 16 pt | [`@fontsource-variable/newsreader`](https://www.npmjs.com/package/@fontsource-variable/newsreader) 5.3.0 | 1.003 |
| `newsreader/Newsreader-Regular.ttf` | Newsreader Regular, a static instance at weight 400 and optical size 16 pt, for the share image, since `ImageResponse` can't read WOFF2 | The [Newsreader project](https://github.com/productiontype/Newsreader)'s variable font, instanced to a static TTF. It matches no file published in that repository or in Google Fonts' `ofl/newsreader` | 1.003 |
| `inter/inter-latin-wght-normal.woff2` | Inter, latin subset, variable weight 100 to 900 | [`@fontsource-variable/inter`](https://www.npmjs.com/package/@fontsource-variable/inter) 5.2.8 | Google Fonts v20, updated 2025-09-10 |

Changing the serif means replacing both Newsreader files, the TTF included.

Replacing the TTF also means changing `SHARE_FONT` in `app/opengraph-image.tsx`. The share image's URL hashes that file, not the font, and the image is cached as immutable.
