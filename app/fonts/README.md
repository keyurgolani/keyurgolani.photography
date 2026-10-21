# Fonts

`app/fonts.ts` loads the two WOFF2 files through `next/font/local`, so the
site serves them from its own origin. Both families are under the SIL Open
Font License 1.1, whose text sits beside each family's files.

| File | What it is | Source | Version |
| --- | --- | --- | --- |
| `newsreader/newsreader-latin-wght-normal.woff2` | Newsreader, latin subset, variable weight 200 to 800, optical size 16 pt | [`@fontsource-variable/newsreader`](https://www.npmjs.com/package/@fontsource-variable/newsreader) 5.3.0 | 1.003 |
| `newsreader/Newsreader-Regular.ttf` | Newsreader Regular, static, for the share image, since `ImageResponse` can't read WOFF2 | The approved review shell's `public/fonts/newsreader-400.ttf` | 1.003 |
| `inter/inter-latin-wght-normal.woff2` | Inter, latin subset, variable weight 100 to 900 | [`@fontsource-variable/inter`](https://www.npmjs.com/package/@fontsource-variable/inter) 5.2.8 | Google Fonts v20, updated 2025-09-10 |

Changing the serif means replacing both Newsreader files, the TTF included.
