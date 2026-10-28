'use client';

import { useRouter } from 'next/navigation';
import { startTransition } from 'react';
import { sans, serif } from '@/app/fonts';
import StatusPage from '@/components/site/StatusPage';
import { ERROR_HEADING, errorCopy, useOnline } from '@/components/site/onlineStatus';
import '@/styles/tokens.css';
import '@/styles/themes.css';
import { THEME_INIT_SCRIPT } from '@/components/site/themeScript';
import './globals.css';
import styles from './global-error.module.css';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * The root layout itself failed, so this page brings its own html and body,
 * with no ThemeProvider and so no SiteNav: a text wordmark, the error copy,
 * Try again, and a way home.
 */
export default function GlobalError({ reset }: GlobalErrorProps) {
  const router = useRouter();
  const online = useOnline();
  const tryAgain = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });
  return (
    <html lang="en" data-theme="dark" data-theme-choice="system" suppressHydrationWarning className={`${serif.variable} ${sans.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="font-sans">
        <header className={styles.header}>
          <p className={styles.wordmark}>
            <span className={styles.monogram}>KG</span> Keyur Golani
          </p>
        </header>
        <StatusPage
          heading={ERROR_HEADING}
          actions={
            <>
              <button type="button" onClick={tryAgain}>
                Try again
              </button>
              {/* A full load, since the app around this page didn't render. */}
              <a href="/">Go to Home</a>
            </>
          }
        >
          {errorCopy(online)}
        </StatusPage>
      </body>
    </html>
  );
}
