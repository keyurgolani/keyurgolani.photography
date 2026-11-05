'use client';

import React from 'react';
import type { AboutPortraitView } from '@/lib/siteConfig/portraitVariants';
import ParallaxCard from './ParallaxCard';
import ResponsivePhoto from './ResponsivePhoto';
import styles from './ProfilePicture.module.css';

/**
 * The portrait's painted width: the frame inside the card's layer, 324 px
 * from `md` up and 260 px below. The badge is the same box at 0.85, so the
 * same file serves both, and 2x picks the 800 px variant.
 */
export const PROFILE_PICTURE_SIZES = '(min-width: 768px) 324px, 260px';

interface ProfilePictureProps {
  /** About's portrait from the site config folder: the same files and URLs About uses. */
  portrait: AboutPortraitView;
  /** No tilt, as under reduced motion. */
  still?: boolean;
  /** The image failed to load, its WebP retry included, so there's nothing to show. ResponsivePhoto catches a failure from before hydration too. */
  onUnusable?: () => void;
}

/**
 * Home's portrait, in the loader and as the badge it lands as: About's one
 * photo in v1.1.0's box, a 256 px card (320 px from `md` up) whose layer
 * overhangs it by 10 px, with an 8 px padded frame and the photo filling it at
 * v1.1.0's painted shape, cropped at portrait.json's focal point. It tilts
 * toward a mouse, and its shadow follows the tilt (ProfilePicture.module.css).
 */
export default function ProfilePicture({ portrait, still = false, onUnusable }: ProfilePictureProps) {
  const { x, y } = portrait.focalPoint;
  return (
    <div className="w-64 h-64 md:w-80 md:h-80 relative" style={{ '--profile-focus': `${x}% ${y}%` } as React.CSSProperties}>
      <ParallaxCard cardOffset={50} still={still} className="w-full h-full">
        <div className="relative w-full h-full p-2">
          <div className={styles.face}>
            <ResponsivePhoto
              asset={portrait.asset}
              alt={portrait.alt}
              sizes={PROFILE_PICTURE_SIZES}
              loading="eager"
              fetchPriority="high"
              preload
              className={styles.image}
              onError={onUnusable}
            />
          </div>
        </div>
      </ParallaxCard>
    </div>
  );
}
