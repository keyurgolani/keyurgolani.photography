'use client';

import React from 'react';
import HeroCarousel from '../../components/HeroCarousel';
import BottomBar from '../../components/BottomBar';
import ProfilePicture from '../../components/ProfilePicture';
import profileBack from '../../public/assets/profile/back.png';
import profileFront from '../../public/assets/profile/front.png';

interface AboutClientProps {
    carouselImages: string[];
}

export default function AboutClient({ carouselImages }: AboutClientProps) {
  return (
    <main className="relative w-full h-screen bg-black overflow-hidden">
        {/* Full Screen Carousel */}
        <div className="absolute inset-0 z-0">
             <HeroCarousel images={carouselImages} />
        </div>
        
        {/* Navigation & Profile */}
        <BottomBar>
            <ProfilePicture 
                profileBack={profileBack} 
                profileFront={profileFront} 
            />
        </BottomBar>
    </main>
  );
}
