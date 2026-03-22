export interface HeroCarouselImage {
  thumbnail: string;
  optimized: string;
  src: string;
}

let heroIntroCompleted = false;
let cachedCarouselImages: HeroCarouselImage[] = [];

export function hasCompletedHomeHeroIntro() {
  return heroIntroCompleted;
}

export function markHomeHeroIntroCompleted() {
  heroIntroCompleted = true;
}

export function getCachedHomeHeroImages() {
  return cachedCarouselImages;
}

export function setCachedHomeHeroImages(images: HeroCarouselImage[]) {
  cachedCarouselImages = [...images];
}
