'use client';

import { navItems } from './nav';
import { useSiteRoutes } from './siteRoutesContext';
import styles from './SiteNav.module.css';

/**
 * SiteNav without its scripts: the wordmark and the Home, Work and About links as plain anchors, in SiteNav's own
 * classes, so it stands at the nav's height, and no theme menu. The error page shows it while its full nav loads, and
 * keeps it if that load fails (offline, or a tab left open across a redeploy), so the page never jumps and always has
 * a way home. It's in every route's first load (app/error.tsx), so it stays this small.
 */
export default function StaticSiteNav() {
  const routes = useSiteRoutes();
  return (
    <nav aria-label="Primary" className={styles.nav}>
      <div className={styles.start}>
        <a href={routes.homeHref()} className={styles.wordmark} aria-label="KG, Keyur Golani">
          <span className={styles.monogram}>KG</span> <span className={styles.name}>Keyur Golani</span>
        </a>
      </div>
      <ul className={styles.items}>
        {navItems(routes).map((item) => (
          <li key={item.section}>
            <a href={item.href} className={styles.item}>
              {item.label}
            </a>
          </li>
        ))}
      </ul>
      <div className={styles.end} />
    </nav>
  );
}
