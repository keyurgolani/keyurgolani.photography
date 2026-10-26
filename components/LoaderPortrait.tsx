'use client';

import React from 'react';
import ParallaxCard from './ParallaxCard';
import ResponsivePhoto from './ResponsivePhoto';
import type { AboutPortraitView } from '@/lib/siteConfig/portraitVariants';
import card from './ParallaxCard.module.css';
import styles from './LoaderPortrait.module.css';

/**
 * STAGE 1 PROTOTYPE. Home's loading portrait as one image, About's portrait
 * from the site config folder, in exactly the box ProfilePicture gives its
 * two layers: 256 px, 320 px from `md` up, a card whose one layer overhangs it
 * by 10 px, an 8 px padded frame, and the image centered in it at the size
 * today's layers paint at (LoaderPortrait.module.css).
 *
 * - `tilt` off, (i): the same markup with no handlers, so nothing moves.
 * - `tilt` on, (ii): ParallaxCard's card tilt with today's cardOffset of 50,
 *   and the one layer's own offset at 0, so the image moves only with the
 *   card, and a shadow that follows the tilt (LoaderPortrait.module.css).
 *   It follows the mouse from the window, since the portrait takes no pointer
 *   (so it never catches a tap meant for the chrome) and the chrome's layer
 *   covers it once a mouse wakes it.
 */
export const LOADER_PORTRAIT_SIZES = '(min-width: 768px) 324px, 260px';

export default function LoaderPortrait({ portrait, tilt }: { portrait: AboutPortraitView; tilt: boolean }) {
  const { x, y } = portrait.focalPoint;
  const image = (
    <div className="relative w-full h-full p-2">
      <ResponsivePhoto
        asset={portrait.asset}
        alt=""
        sizes={LOADER_PORTRAIT_SIZES}
        loading="eager"
        fetchPriority="high"
        preload
        className={tilt ? `${styles.image} ${styles.tilted}` : styles.image}
      />
    </div>
  );
  return (
    <div
      data-loader-portrait={tilt ? 'tilt' : 'still'}
      className="w-64 h-64 md:w-80 md:h-80 relative"
      style={{ '--loader-focus': `${x}% ${y}%` } as React.CSSProperties}
    >
      {tilt ? (
        <ParallaxCard cardOffset={50} baseLayerOffset={0} layerOffsetMultiplier={0} trackWindow className="w-full h-full">
          {image}
        </ParallaxCard>
      ) : (
        <div className={`${card.card} w-full h-full`}>
          <div className={card.layer}>{image}</div>
        </div>
      )}
    </div>
  );
}
