import React from 'react';
import { getGalleryImages } from '../../utils/getImageData';
import AboutClient from './AboutClient';

export default async function About() {
  const images = await getGalleryImages();
  const carouselImages = images.length > 0 ? images.map(img => img.src) : ['/assets/photos/back.png'];

  return <AboutClient carouselImages={carouselImages} />;
}
