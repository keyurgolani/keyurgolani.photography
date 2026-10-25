import type { StaticImageData } from 'next/image';
import React from 'react';
import ExternalLinks from '../../components/ExternalLinks';
import type { ArtistProfile, ExternalDestination } from '../../data/artist';
import ArtistPortrait from './ArtistPortrait';
import NameLine from './NameLine';
import styles from './about.module.css';

export interface AboutViewProps {
  profile: ArtistProfile;
  /** The portrait file, used only when the profile has a portrait. */
  portraitSrc: StaticImageData | string;
  destinations: ExternalDestination[];
}

/**
 * About on Light Takes Shape paper. Inside main the DOM order is the reading
 * order at every width: the portrait (or the name, without one), the
 * statement heading, its paragraphs, any biography, then the external links.
 * The CSS never reorders it.
 */
export default function AboutView({ profile, portraitSrc, destinations }: AboutViewProps) {
  const { name, alias, portrait } = profile;
  return (
    <main data-surface="about" className={styles.root}>
      <div className={styles.layout}>
        {portrait ? (
          <ArtistPortrait portrait={{ ...portrait, src: portraitSrc }} name={name} alias={alias} />
        ) : (
          <p data-testid="about-portrait" className={styles.name}>
            <NameLine name={name} alias={alias} />
          </p>
        )}
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
