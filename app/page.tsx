import React from 'react';
import { getGalleryImages } from '../utils/getImageData';
import HeroCarousel from '../components/HeroCarousel';
import RevealingContents from '../components/RevealingContents';
import BottomBar from '../components/BottomBar';
import ProfilePicture from '../components/ProfilePicture';
import profileBack from '../public/assets/profile/back.png';
import profileFront from '../public/assets/profile/front.png';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const images = await getGalleryImages();

  // If no images, we can optionally show a placeholder or nothing.
  // Ideally, the user should provide images in public/assets/photos.
  const carouselImages = images.map(img => img.src);

  return (
    <main className="relative w-full h-screen bg-black overflow-hidden">
        {/* Full Screen Carousel as background/hero */}
        <div className="absolute inset-0 z-0">
            <HeroCarousel images={carouselImages} />
        </div>

        {/* Revealing Content Overlay - Controls visibility of children */}
        <RevealingContents>
            <div className="flex flex-col items-center justify-end h-full pb-8">
                <BottomBar>
                    <div className="transform transition-transform hover:scale-105 duration-500">
                        <ProfilePicture 
                            profileBack={profileBack} 
                            profileFront={profileFront} 
                        />
                    </div>
                </BottomBar>
            </div>
        </RevealingContents>
    </main>
  );
}
