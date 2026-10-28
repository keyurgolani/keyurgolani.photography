import type { ReactNode } from 'react';
import styles from './StatusPage.module.css';

interface StatusPageProps {
  heading: string;
  /** The page's one paragraph. */
  children: ReactNode;
  /** The links or buttons that lead on. */
  actions: ReactNode;
  /** For a page with no SiteNav, such as the curator's: the ground fills the whole window instead of leaving the nav's height to the body. */
  standalone?: boolean;
}

/** The layout the not-found and error pages share: a serif heading, one paragraph, and actions, on the ground. */
export default function StatusPage({ heading, children, actions, standalone = false }: StatusPageProps) {
  return (
    <main className={standalone ? `${styles.page} ${styles.standalone}` : styles.page}>
      <div className={styles.body}>
        <h1 className={styles.heading}>{heading}</h1>
        <p className={styles.text}>{children}</p>
        <div className={styles.actions}>{actions}</div>
      </div>
    </main>
  );
}
