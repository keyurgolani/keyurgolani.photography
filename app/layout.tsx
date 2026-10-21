import type { Metadata } from 'next';
import '../styles/tokens.css';
import '../styles/surfaces/light-takes-shape.css';
import '../styles/surfaces/chromatic-chapters.css';
import './globals.css';
import { sans, serif } from './fonts';
import { ThemeProvider } from '../components/ThemeContext';
import { THEME_INIT_SCRIPT } from '../components/site/themeScript';

export const metadata: Metadata = {
  title: 'Keyur Golani - Photography',
  description: 'Photography portfolio of Keyur Golani',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The server always sends the dark theme. The inline script swaps in a stored light one before first paint,
  // which is why <html> suppresses the hydration warning for its own attributes.
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning className={`${serif.variable} ${sans.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="font-sans">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
