import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageResponse } from 'next/og';

export const alt = 'Keyur Golani Photography';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * The name the image sets its TTF under, which names the TTF's version. Next
 * puts a hash of this source file, not of the font, into the image's URL, and
 * serves the image as immutable, so this has to change whenever the TTF does,
 * or the old image stays cached under the old URL.
 */
const SHARE_FONT = 'Newsreader-1-003-static-400-16pt';

/**
 * The site's share image: the KG monogram, the name, and "Photography" on the
 * ground. The build renders it once. ImageResponse can't read WOFF2, so it
 * sets the type in the static Newsreader TTF.
 */
export default async function OpenGraphImage() {
  // The build renders this route once, so the font is read only then. The
  // ignore comment keeps Turbopack from tracing app/ into .next/standalone.
  const newsreader = await readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), 'app/fonts/newsreader/Newsreader-Regular.ttf'));
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#080a09',
          color: '#f4f6f5',
          fontFamily: SHARE_FONT,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 112,
            height: 112,
            borderRadius: 56,
            border: '2px solid rgba(255, 255, 255, 0.38)',
            fontSize: 44,
          }}
        >
          KG
        </div>
        <div style={{ marginTop: 48, fontSize: 96, lineHeight: 1, letterSpacing: '-0.02em' }}>Keyur Golani</div>
        <div style={{ marginTop: 24, fontSize: 32, letterSpacing: '0.08em', color: 'rgba(244, 246, 245, 0.62)' }}>Photography</div>
      </div>
    ),
    { ...size, fonts: [{ name: SHARE_FONT, data: newsreader, weight: 400, style: 'normal' }] },
  );
}
