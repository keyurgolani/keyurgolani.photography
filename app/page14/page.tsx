import React from 'react';
import DynamicHeroCarousel from '../../components/DynamicHeroCarousel';
import RevealingContents from '../../components/RevealingContents';
import BottomBar from '../../components/BottomBar';
import ProfilePicture from '../../components/ProfilePicture';
import profileBack from '../../public/assets/profile/back.png';
import profileFront from '../../public/assets/profile/front.png';
import LineDrawingBlindsLoader from './LineDrawingBlindsLoader';

export default function Page14() {
    return (
        <main className="relative w-full h-screen bg-black overflow-hidden">
            <LineDrawingBlindsLoader />
            <div className="absolute inset-0 z-0">
                <DynamicHeroCarousel />
            </div>
            <RevealingContents>
                <div className="flex flex-col items-center justify-end h-full pb-8">
                    <BottomBar>
                        <div className="transform transition-transform hover:scale-105 duration-500">
                            <ProfilePicture profileBack={profileBack} profileFront={profileFront} />
                        </div>
                    </BottomBar>
                </div>
            </RevealingContents>
        </main>
    );
}