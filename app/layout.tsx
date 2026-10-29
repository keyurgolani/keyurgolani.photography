import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import '../styles/tokens.css';
import '../styles/surfaces/light-takes-shape.css';
import '../styles/surfaces/chromatic-chapters.css';
import './globals.css';
// After globals: the five themes, and the theme control's button. Both audiences share this one stylesheet, so no
// CSS module of the control's is shared by the visitor and the curator routes (that merged the curator's styles into a
// chunk every visitor page loads).
import '../styles/themes.css';
import { sans, serif } from './fonts';
import { ThemeProvider } from '../components/ThemeContext';
import { THEME_INIT_SCRIPT } from '../components/site/themeScript';
import { getMetadataBase } from '../lib/site/config';
import { SITE_NAME, siteOpenGraph } from '../lib/site/metadata';

// Every page renders per request, so the share URLs follow the SITE_URL each server starts with.
export async function generateMetadata(): Promise<Metadata> {
  await connection();
  return {
    metadataBase: getMetadataBase(),
    title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
    description: 'Photography portfolio of Keyur Golani',
    openGraph: siteOpenGraph,
    twitter: { card: 'summary_large_image' },
  };
}

// The browser's own bar follows System's pair: Light's paper on a light device, Black's (today's) ground on a dark one.
// An explicit choice paints both with its own ground (ThemeProvider).
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ebe5d9' },
    { media: '(prefers-color-scheme: dark)', color: '#080a09' },
  ],
};

/** Without JavaScript nothing in the theme menu could work, so the control isn't shown at all. */
const NO_SCRIPT_THEME_STYLE = '[data-theme-control]{display:none}';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The server always sends System painting Black, today's site, which is what a visitor without JavaScript sees. The
  // inline script puts the stored choice and its theme there before first paint, which is why <html> suppresses the
  // hydration warning for its own attributes.
  return (
    <html lang="en" data-theme="black" data-theme-choice="system" suppressHydrationWarning className={`${serif.variable} ${sans.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <noscript>
          <style>{NO_SCRIPT_THEME_STYLE}</style>
        </noscript>
      </head>
      <body className="font-sans">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
