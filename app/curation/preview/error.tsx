'use client';

import { useRouter } from 'next/navigation';
import { startTransition } from 'react';
import StatusPage from '@/components/site/StatusPage';

/** The preview frame couldn't read the working catalog (#16). It never shows the error's message, digest, or stack. */
export default function PreviewError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const tryAgain = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });
  return (
    <StatusPage
      heading="The preview didn't load"
      actions={
        <button type="button" onClick={tryAgain}>
          Try again
        </button>
      }
    >
      The working catalog couldn&apos;t be read just now. Try again in a moment.
    </StatusPage>
  );
}
