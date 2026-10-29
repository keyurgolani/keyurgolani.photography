'use client';

import { useEffect, type RefObject } from 'react';
import { boxOf, copyTone, positionOf, unionOf, type Box } from '../badgePlace';

/**
 * The tone of the photograph under Home's copy, on Home's root as `data-copy-tone`: measured once the photograph on
 * screen (`photoId`, in the slide stack under `carousel`) has loaded, at each slide change, and again whenever the copy
 * changes size. Light's and Bright's copy takes a dark scrim over a dark photograph (HomeChrome.module.css; spec §5).
 * Before it's measured, or with no copy on the page, there's no tone, which is the theme's own scrim.
 */
export function useCopyTone(carousel: RefObject<HTMLElement | null>, photoId: string | undefined, loaded: boolean) {
  useEffect(() => {
    const root = carousel.current?.closest('main');
    if (!root) return;
    const image = photoId !== undefined && loaded ? carousel.current?.querySelector<HTMLImageElement>(`[data-photo-id="${CSS.escape(photoId)}"] img`) : null;
    const story = root.querySelector('[data-chrome-region="story"]');
    if (!image || !story) return;
    let current = true;
    const measure = () => {
      const boxes = [...story.querySelectorAll(':is(h1, h2, p, a)'), ...root.querySelectorAll('[data-chrome-panel]')].map(boxOf).filter((box): box is Box => box !== null);
      const copy = unionOf(boxes);
      if (!copy) return;
      void copyTone(image, copy, { position: positionOf(getComputedStyle(image).objectPosition) }).then((tone) => {
        if (current) root.setAttribute('data-copy-tone', tone);
      });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(story);
    return () => {
      current = false;
      observer?.disconnect();
    };
  }, [carousel, photoId, loaded]);

  useEffect(() => {
    const root = carousel.current?.closest('main');
    return () => root?.removeAttribute('data-copy-tone');
  }, [carousel]);
}
