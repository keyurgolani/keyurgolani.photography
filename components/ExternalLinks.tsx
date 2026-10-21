import { ExternalLink } from 'lucide-react';
import type { ExternalDestination } from '@/data/artist';
import ExternalLinkIcon from './ExternalLinkIcon';
import styles from './ExternalLinks.module.css';

/** Only `https:` and `mailto:` hrefs render, which keeps `javascript:` and relative URLs out. */
function hasSafeHref({ href }: ExternalDestination): boolean {
  try {
    const { protocol } = new URL(href);
    return protocol === 'https:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}

/**
 * About's links to the artist's profiles, the site source, and any contact,
 * in authored order. Disabled entries and unsafe hrefs are left out, and with
 * none left there's no nav. Every link opens in the same tab.
 */
export default function ExternalLinks({ destinations }: { destinations: ExternalDestination[] }) {
  const shown = destinations.filter((destination) => destination.enabled && hasSafeHref(destination));
  if (shown.length === 0) return null;
  const name = shown.some((destination) => destination.kind === 'contact') ? 'External profiles and contact' : 'External profiles';
  return (
    <nav aria-label={name} className={styles.nav}>
      {/* Safari drops list semantics along with the list styling, so the role is explicit. */}
      <ul role="list" className={styles.list}>
        {shown.map(({ id, label, href, icon }) => (
          <li key={id}>
            <a href={href} className={styles.link}>
              {icon ? <ExternalLinkIcon icon={icon} className={styles.icon} /> : null}
              <span className={styles.label}>{label}</span>
              <ExternalLink size={14} strokeWidth={1.5} className={styles.arrow} aria-hidden="true" focusable="false" />
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
