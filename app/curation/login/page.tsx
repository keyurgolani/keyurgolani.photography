import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import SameOriginPostForm from '@/components/site/SameOriginPostForm';
import { hasCuratorSession, requireCuratorLogin } from '@/lib/curation/auth';
import { loginLocked } from '@/lib/curation/auth/login';
import styles from './login.module.css';

/**
 * The curator's login (#14's 14-2): the one curator page that asks for no
 * session. It still gets the flag, the bind and secrets, and the `Host`
 * checks, and the curator headers. Its form posts to /api/curation/login
 * with fetch, so the browser sends the `Origin` that handler checks (see
 * SameOriginPostForm), and that handler answers a wrong
 * passphrase and the lock the same way, so the only thing this page adds is
 * whether the lock is on. It reads nothing from the data root.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Curator login', robots: { index: false, follow: false } };

export default async function CuratorLoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireCuratorLogin({ read: true });
  if (await hasCuratorSession()) redirect('/curation');
  const failed = (await searchParams).failed === '1';
  const locked = loginLocked();
  return (
    <main className={styles.page}>
      <div className={styles.body}>
        <h1 className={styles.heading}>Curator login</h1>
        <p className={styles.text}>Enter the passphrase set for this curator when it was deployed.</p>
        {failed || locked ? (
          <div className={styles.notice} role="alert">
            {failed ? <p>That didn&apos;t sign you in. Check the passphrase and try again.</p> : null}
            {locked ? <p>Login is paused for 15 minutes after five failed tries. Try again later.</p> : null}
          </div>
        ) : null}
        <SameOriginPostForm className={styles.form} buttonClassName={styles.button} action="/api/curation/login" submitLabel="Sign in">
          <label className={styles.label} htmlFor="curator-passphrase">
            Passphrase
          </label>
          <input
            className={styles.input}
            id="curator-passphrase"
            name="passphrase"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
          />
        </SameOriginPostForm>
      </div>
    </main>
  );
}
