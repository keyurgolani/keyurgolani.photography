'use client';

import Image, { type StaticImageData } from 'next/image';
import React, { useState } from 'react';
import type { ArtistPortrait as ArtistPortraitData } from '../../data/artist';
import NameLine from './NameLine';
import styles from './about.module.css';

export interface ArtistPortraitProps {
  portrait: ArtistPortraitData & { src: StaticImageData | string };
  name: string;
  alias?: string;
}

/** Wide, the portrait takes the 41% column. Stacked, the full width inside the page padding. */
export const PORTRAIT_SIZES = '(min-width: 64rem) 41vw, 100vw';

/**
 * The portrait in its paper frame, with the name and alias in a caption band
 * below the photo, in flow, so enlarged text can't cover the face. The client
 * is needed only for onError: a failed load swaps the figure for a box of the
 * same size holding the name and alias as text, with no broken-image icon.
 * Nothing here tilts, scales, or transitions.
 */
export default function ArtistPortrait({ portrait, name, alias }: ArtistPortraitProps) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div data-testid="about-portrait" className={`${styles.portrait} ${styles.fallback}`}>
        <p className={styles.fallbackName}>
          <NameLine name={name} alias={alias} />
        </p>
      </div>
    );
  }
  const { x, y } = portrait.focalPoint ?? { x: 50, y: 50 };
  return (
    <figure data-testid="about-portrait" className={styles.portrait}>
      <div className={styles.photo}>
        <Image
          src={portrait.src}
          width={portrait.width}
          height={portrait.height}
          alt={portrait.alt}
          sizes={PORTRAIT_SIZES}
          preload
          className={styles.image}
          style={{ objectPosition: `${x}% ${y}%` }}
          onError={() => setFailed(true)}
        />
      </div>
      <figcaption className={styles.caption}>
        <NameLine name={name} alias={alias} />
      </figcaption>
    </figure>
  );
}
