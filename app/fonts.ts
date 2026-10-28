import localFont from 'next/font/local';

// Self-hosted from app/fonts/, whose README names each file's source and version.

export const serif = localFont({
  src: [{ path: './fonts/newsreader/newsreader-latin-wght-normal.woff2', weight: '200 800', style: 'normal' }],
  variable: '--font-serif',
  display: 'swap',
  adjustFontFallback: 'Times New Roman',
});

export const sans = localFont({
  src: [{ path: './fonts/inter/inter-latin-wght-normal.woff2', weight: '100 900', style: 'normal' }],
  variable: '--font-sans',
  display: 'swap',
  adjustFontFallback: 'Arial',
});
