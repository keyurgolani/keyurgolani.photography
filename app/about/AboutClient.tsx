'use client';

import React from 'react';
import BottomBar from '../../components/BottomBar';
import ProfilePicture from '../../components/ProfilePicture';
import PhotographerProfile from '../../components/PhotographerProfile';
import profileBack from '../../public/assets/profile/back.png';
import profileFront from '../../public/assets/profile/front.png';

export default function AboutClient() {
  return (
    <main className="relative w-full h-screen bg-black overflow-hidden">
        {/* Background gradient */}
        <div className="absolute inset-0 bg-gradient-to-b from-black via-neutral-900 to-black z-0" />
        
        {/* Scattered social profile cards - like cards on a desk */}
        <PhotographerProfile />
        
        {/* Name and alias overlay */}
        <div className="absolute top-8 left-1/2 -translate-x-1/2 z-20 text-center">
            <h1 className="text-3xl sm:text-4xl font-bold text-white mb-1 font-primary drop-shadow-lg">Keyur Golani</h1>
            <p className="text-lg text-white/70 font-light tracking-wide drop-shadow-md">aka ISerialClicker</p>
        </div>
        
        {/* Navigation & Profile - same position as home page */}
        <BottomBar>
            <div className="transform transition-transform hover:scale-105 duration-500">
                <ProfilePicture 
                    profileBack={profileBack} 
                    profileFront={profileFront} 
                />
            </div>
        </BottomBar>
    </main>
  );
}
