'use client';

import { useEffect, type RefObject } from 'react';
import { boxOf, copyTone, positionOf, unionOf, type Box } from '../badgePlace';

/** How long a resize or a rotation settles before the tone is measured again. */
export const TONE_SETTLE_MS = 150;

/**
 * The tone of the photograph under Home's copy, on Home's root as `data-copy-tone`: measured once the photograph on
 * screen (`photoId`, in the slide stack under `carousel`) has loaded, at each slide change, and again whenever its
 * image loads a new source (a rotation or a wider window picks a larger srcset candidate, M5) or the copy or the
 * window changes size, settled for TONE_SETTLE_MS. Light's and Bright's copy takes a dark scrim over a dark photograph
 * (HomeChrome.module.css; spec §5). Before it's measured, or with no copy on the page, there's no tone, which is the
 * theme's own scrim. A measure that can't read the image now keeps the tone it has.
 */
export function useCopyTone(carousel: RefObject<HTMLElement | null>, photoId: string | undefined, loaded: boolean) {
  useEffect(() => {
    const root = carousel.current?.closest('main');
    if (!root) return;
    const image = photoId !== undefined && loaded ? carousel.current?.querySelector<HTMLImageElement>(`[data-photo-id="${CSS.escape(photoId)}"] img`) : null;
    const story = root.querySelector('[data-chrome-region="story"]');
    if (!image || !story) return;
    let current = true;
    // Only the newest measure writes, however the samples resolve (L6).
    let latest = 0;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const boxes = [...story.querySelectorAll(':is(h1, h2, p, a)'), ...root.querySelectorAll('[data-chrome-panel]')].map(boxOf).filter((box): box is Box => box !== null);
      const copy = unionOf(boxes);
      if (!copy) return;
      const run = ++latest;
      void copyTone(image, copy, { position: positionOf(getComputedStyle(image).objectPosition) }).then((tone) => {
        if (current && run === latest && tone !== null) root.setAttribute('data-copy-tone', tone);
      });
    };
    const later = () => {
      clearTimeout(settle);
      settle = setTimeout(measure, TONE_SETTLE_MS);
    };
    measure();
    image.addEventListener('load', measure);
    window.addEventListener('resize', later);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later);
    observer?.observe(story);
    return () => {
      current = false;
      clearTimeout(settle);
      image.removeEventListener('load', measure);
      window.removeEventListener('resize', later);
      observer?.disconnect();
    };
  }, [carousel, photoId, loaded]);

  useEffect(() => {
    const root = carousel.current?.closest('main');
    return () => root?.removeAttribute('data-copy-tone');
  }, [carousel]);
}
