import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import '../styles/tokens.css';
import '../styles/surfaces/light-takes-shape.css';
import '../styles/surfaces/chromatic-chapters.css';
import '../styles/themes.css';
import './globals.css';
// The theme menu's styles, global and loaded with the layout (themes mockup, round 2; see the file's note).
import '../styles/theme-menu.css';
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

// The browser's own bar follows System's two themes, Light and Black (today's #080a09); an explicit Bright or Dark
// choice keeps the nearest one.
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ebe5d9' },
    { media: '(prefers-color-scheme: dark)', color: '#080a09' },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The server always sends System painting Black, today's site, which is what a visitor without JavaScript gets. The
  // inline script puts the stored choice and its theme there before first paint, which is why <html> suppresses the
  // hydration warning for its own attributes.
  return (
    <html lang="en" data-theme="black" data-theme-choice="system" suppressHydrationWarning className={`${serif.variable} ${sans.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="font-sans">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
