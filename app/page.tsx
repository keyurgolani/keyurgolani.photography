'use client';

import React, { useState } from 'react';
import DynamicHeroCarousel from '../components/DynamicHeroCarousel';
import RevealingContents from '../components/RevealingContents';
import BottomBar from '../components/BottomBar';
import ProfilePicture from '../components/ProfilePicture';
import LoadingAnimation from '../components/LoadingAnimation';
import profileBack from '../public/assets/profile/back.png';
import profileFront from '../public/assets/profile/front.png';

export default function Home() {
    const [isLoading, setIsLoading] = useState(true);

    const handleFirstImageLoaded = () => {
        setIsLoading(false);
    };

    return (
        <main className="relative w-full h-screen bg-black overflow-hidden">
            {/* Loading Animation Overlay */}
            <LoadingAnimation isLoading={isLoading} />
            
            {/* Full Screen Carousel as background/hero - fetches images dynamically */}
            <div className="absolute inset-0 z-0">
                <DynamicHeroCarousel onFirstImageLoaded={handleFirstImageLoaded} />
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