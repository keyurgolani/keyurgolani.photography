// Module memory, so it lasts through client navigation in a tab and a reload forgets it.
let heroIntroCompleted = false;
let playbackPaused = false;

export function hasCompletedHomeHeroIntro() {
  return heroIntroCompleted;
}

export function markHomeHeroIntroCompleted() {
  heroIntroCompleted = true;
}

/** Whether the visitor paused the slideshow. Only a Pause is remembered, never a Play. */
export function isHomePlaybackPaused() {
  return playbackPaused;
}

export function rememberHomePlaybackPaused(paused: boolean) {
  playbackPaused = paused;
}
