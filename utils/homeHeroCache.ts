import type { HomePhoto } from '@/components/home/homePhoto';

// Module memory, so it lasts through client navigation in a tab and a reload forgets it.
let heroIntroCompleted = false;
let cachedHomePhotos: HomePhoto[] = [];
let playbackPaused = false;

export function hasCompletedHomeHeroIntro() {
  return heroIntroCompleted;
}

export function markHomeHeroIntroCompleted() {
  heroIntroCompleted = true;
}

export function getCachedHomeHeroImages() {
  return cachedHomePhotos;
}

export function setCachedHomeHeroImages(photos: HomePhoto[]) {
  cachedHomePhotos = [...photos];
}

/** Whether the visitor paused the slideshow. Only a Pause is remembered, never a Play. */
export function isHomePlaybackPaused() {
  return playbackPaused;
}

export function rememberHomePlaybackPaused(paused: boolean) {
  playbackPaused = paused;
}
