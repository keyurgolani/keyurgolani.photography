import React from 'react';
import ExternalLinks from '../../components/ExternalLinks';
import type { ArtistProfile, ExternalDestination } from '../../data/artist';
import type { AboutPortraitView } from '../../lib/siteConfig/portraitVariants';
import ArtistPortrait from './ArtistPortrait';
import styles from './about.module.css';

export interface AboutViewProps {
  profile: ArtistProfile;
  /** The host's portrait, or null for the no-photo layout. */
  portrait: AboutPortraitView | null;
  destinations: ExternalDestination[];
}

/**
 * About on Light Takes Shape paper. Inside main the DOM order is the reading
 * order at every width: the portrait (or the name panel, without one), the
 * statement heading, its paragraphs, any biography, then the external links.
 * The CSS never reorders it.
 */
export default function AboutView({ profile, portrait, destinations }: AboutViewProps) {
  const { name, alias } = profile;
  return (
    <main data-surface="about" className={styles.root}>
      <div className={styles.layout}>
        <ArtistPortrait portrait={portrait} name={name} alias={alias} />
        <article className={styles.article}>
          <h1 data-testid="about-heading" className={styles.heading}>
            {profile.statementHeading}
          </h1>
          {profile.statementParagraphs.map((text, index) => (
            <p key={index} className={styles.paragraph}>
              {text}
            </p>
          ))}
          {profile.shortBiography ? <p className={`${styles.paragraph} ${styles.biography}`}>{profile.shortBiography}</p> : null}
          <div className={styles.links}>
            <ExternalLinks destinations={destinations} />
          </div>
        </article>
      </div>
    </main>
  );
}
