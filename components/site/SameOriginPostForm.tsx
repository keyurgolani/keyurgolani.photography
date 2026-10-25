'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

interface SameOriginPostFormProps {
  /** The same-origin URL the form posts to. */
  action: string;
  /** The submit button's text. */
  submitLabel: string;
  className?: string;
  buttonClassName?: string;
  /** The fields before the button, if any. */
  children?: ReactNode;
}

/**
 * A form that posts with fetch, then goes where the answer led.
 *
 * The curator's pages send `Referrer-Policy: no-referrer`, and under that
 * policy a browser sends `Origin: null` on a plain form post, which the
 * curator's `Origin` check refuses (lib/curation/auth/policy.ts). A fetch to
 * the same origin always sends the real `Origin`. The button stays disabled
 * until this has hydrated, so the form never posts the plain way. The cookie
 * a response sets is kept as for any same-origin fetch.
 */
export default function SameOriginPostForm({ action, submitLabel, className, buttonClassName, children }: SameOriginPostFormProps) {
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => setReady(true), []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    setFailed(false);
    try {
      const body = new URLSearchParams();
      for (const [name, value] of new FormData(event.currentTarget)) if (typeof value === 'string') body.append(name, value);
      const response = await fetch(action, { method: 'POST', body, credentials: 'same-origin', cache: 'no-store' });
      if (response.redirected && new URL(response.url).origin === window.location.origin) {
        window.location.assign(response.url);
        return;
      }
      setFailed(true);
    } catch {
      setFailed(true);
    }
    setSending(false);
  }

  return (
    <form className={className} method="post" action={action} onSubmit={submit}>
      {children}
      <button className={buttonClassName} type="submit" disabled={!ready || sending}>
        {submitLabel}
      </button>
      {failed ? <p role="alert">That didn&apos;t go through. Reload the page and try again.</p> : null}
    </form>
  );
}
