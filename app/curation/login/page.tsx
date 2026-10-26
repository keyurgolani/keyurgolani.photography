import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import SameOriginPostForm from '@/components/site/SameOriginPostForm';
import { hasCuratorSession, requireCuratorLogin } from '@/lib/curation/auth';
import { loginLockedUntil } from '@/lib/curation/auth/login';
import styles from './login.module.css';

/**
 * The curator's login (#14's 14-2): the one curator page that asks for no
 * session. It still gets the flag, the bind and secrets, and the `Host`
 * checks, and the curator headers. Its form posts to /api/curation/login
 * with fetch, so the browser sends the `Origin` that handler checks (see
 * SameOriginPostForm), and that handler answers a wrong passphrase and the
 * lock the same way. So the page decides the lock on its own: while it's on,
 * the page says only that, and about how long it has left, whatever the
 * last try was. It reads nothing from the data root.
 *
 * The other notices come from the query: `failed=1` from the login handler,
 * `signed-out=1` from logout, and `ended=1` from a page read whose session
 * cookie no longer counts. None of them changes what the form posts.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Sign in to curation', robots: { index: false, follow: false } };

const NOTICE_ID = 'curator-login-notice';

type Notice = { kind: 'locked'; minutes: number } | { kind: 'failed' } | { kind: 'ended' } | { kind: 'signed-out' };

function noticeFor(search: Record<string, string | string[] | undefined>, lockedUntil: number | null, now: number): Notice | null {
  if (lockedUntil !== null) return { kind: 'locked', minutes: Math.max(1, Math.ceil((lockedUntil - now) / 60_000)) };
  if (search.failed === '1') return { kind: 'failed' };
  if (search.ended === '1') return { kind: 'ended' };
  if (search['signed-out'] === '1') return { kind: 'signed-out' };
  return null;
}

function NoticeText({ notice }: { notice: Notice }) {
  switch (notice.kind) {
    case 'locked':
      return (
        <>
          Sign-in is paused after five wrong passphrases, and until it ends no passphrase is checked, the right one included. Try again in{' '}
          {notice.minutes === 1 ? 'about a minute' : `about ${notice.minutes} minutes`}, or restart curator on the server. If those tries weren&apos;t yours,
          someone else can reach the curator.
        </>
      );
    case 'failed':
      return <>That didn&apos;t sign you in. Check the passphrase and try again.</>;
    case 'ended':
      return <>Your session ended. Sign in again.</>;
    case 'signed-out':
      return <>You&apos;re signed out.</>;
  }
}

export default async function CuratorLoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireCuratorLogin({ read: true });
  if (await hasCuratorSession()) redirect('/curation');
  const now = Date.now();
  const notice = noticeFor(await searchParams, loginLockedUntil(now), now);
  // A refusal goes under the field, as the Inbox's does; a status line goes above the form.
  const refusal = notice?.kind === 'locked' || notice?.kind === 'failed';
  const noticeLine = notice ? (
    <p id={NOTICE_ID} className={refusal ? styles.refusal : styles.status} role={refusal ? undefined : 'status'} data-notice={notice.kind}>
      <NoticeText notice={notice} />
    </p>
  ) : null;
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.wordmark}>
          <span className={styles.monogram} aria-hidden="true">
            KG
          </span>
          Portfolio curation
        </Link>
      </header>
      <main className={styles.main}>
        <div className={styles.body}>
          <h1 className={styles.heading}>Sign in to curation</h1>
          <p className={styles.text}>Enter the passphrase you chose when you set up the curator.</p>
          {refusal ? null : noticeLine}
          <SameOriginPostForm
            className={styles.form}
            buttonClassName={styles.button}
            alertClassName={styles.refusal}
            action="/api/curation/login"
            submitLabel="Sign in"
            pendingLabel="Signing in…"
          >
            {/* For password managers, which file a passphrase under a username. The login handler reads only `passphrase`. */}
            <input type="text" name="username" autoComplete="username" value="curator" readOnly hidden aria-hidden="true" tabIndex={-1} />
            <label className={styles.label} htmlFor="curator-passphrase">
              Passphrase
            </label>
            {/* autoFocus puts the field, and with it the notice it's described by, first in line for a screen reader on every load. */}
            <input
              className={styles.input}
              id="curator-passphrase"
              name="passphrase"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              aria-invalid={notice?.kind === 'failed' ? true : undefined}
              aria-describedby={notice ? NOTICE_ID : undefined}
            />
            {refusal ? noticeLine : null}
          </SameOriginPostForm>
        </div>
      </main>
    </div>
  );
}
