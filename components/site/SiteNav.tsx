'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import ThemeToggle from '@/components/ThemeToggle';
import { currentSection, NAV_ITEMS } from './nav';
import styles from './SiteNav.module.css';

export interface SiteNavProps {
  /** `'about'` paints the Light Takes Shape paper variant. */
  surface?: 'gallery' | 'about';
}

/**
 * The site navigation: the wordmark, the Home, Work, and About links, and the
 * theme toggle. It has no visibility state, timers, or positioning of its own,
 * so Home's chrome places it and decides when it shows.
 */
export default function SiteNav({ surface = 'gallery' }: SiteNavProps) {
  const section = currentSection(usePathname());
  return (
    <nav aria-label="Primary" className={styles.nav} data-surface={surface === 'about' ? 'about' : undefined}>
      <div className={styles.start}>
        {/*
          The name holds the visible "KG Keyur Golani" in order (WCAG 2.5.3). The space
          keeps the two spans separate words in the text; the flex row doesn't render it.
        */}
        <Link href="/" className={styles.wordmark} aria-label="KG, Keyur Golani">
          <span className={styles.monogram}>KG</span>{' '}
          <span className={styles.name}>Keyur Golani</span>
        </Link>
      </div>
      <ul className={styles.items}>
        {NAV_ITEMS.map((item) => (
          <li key={item.section}>
            <Link href={item.href} className={styles.item} aria-current={item.section === section ? 'page' : undefined}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
      <div className={styles.end}>
        <ThemeToggle />
      </div>
    </nav>
  );
}
