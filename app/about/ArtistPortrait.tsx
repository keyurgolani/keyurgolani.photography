'use client';

import React, { useCallback, useState } from 'react';
import ResponsivePhoto from '../../components/ResponsivePhoto';
import type { AboutPortraitView } from '../../lib/siteConfig/portraitVariants';
import NameLine from './NameLine';
import styles from './about.module.css';

export interface ArtistPortraitProps {
  /** Null when the host's site config folder holds no usable portrait. */
  portrait: AboutPortraitView | null;
  name: string;
  alias?: string;
}

/** Wide, the portrait takes the 41% column. Stacked, the full width inside the page padding. */
export const PORTRAIT_SIZES = '(min-width: 64rem) 41vw, 100vw';

/**
 * The portrait in its paper frame, with the name and alias in a caption band
 * below the photo, in flow, so enlarged text can't cover the face. With no
 * portrait, or once one fails to load, the same frame holds a lit paper
 * panel with the name and alias set as text: no broken-image icon, and the
 * column keeps its size, so the page reads the same either way. The client
 * is needed only to notice a failed load. Nothing here tilts, scales, or transitions.
 */
export default function ArtistPortrait({ portrait, name, alias }: ArtistPortraitProps) {
  const [failed, setFailed] = useState(false);
  // The server-rendered image can fail before React hydrates and attaches
  // onError, so check it once React has it: complete with no pixels is a failed load.
  const checkLoaded = useCallback((image: HTMLImageElement | null) => {
    if (image && image.complete && image.naturalWidth === 0) setFailed(true);
  }, []);
  if (portrait === null || failed) {
    return (
      <div data-testid="about-portrait" className={`${styles.portrait} ${styles.fallback}`}>
        <p className={styles.fallbackName}>
          <span className={styles.fallbackFullName}>{name}</span>
          {/* The dot is for the text and screen readers: the alias shows on its own line. */}
          {alias ? (
            <span className={styles.fallbackAlias}>
              <span className="sr-only"> · </span>
              {alias}
            </span>
          ) : null}
        </p>
      </div>
    );
  }
  const { x, y } = portrait.focalPoint;
  return (
    <figure data-testid="about-portrait" className={styles.portrait}>
      <div className={styles.photo} style={{ '--portrait-focus': `${x}% ${y}%` } as React.CSSProperties}>
        <ResponsivePhoto
          asset={portrait.asset}
          alt={portrait.alt}
          sizes={PORTRAIT_SIZES}
          loading="eager"
          fetchPriority="high"
          preload
          className={styles.image}
          onError={() => setFailed(true)}
          ref={checkLoaded}
        />
      </div>
      <figcaption className={styles.caption}>
        <NameLine name={name} alias={alias} />
      </figcaption>
    </figure>
  );
}
