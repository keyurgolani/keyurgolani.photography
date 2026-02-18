'use client';

import React from 'react';
import { Github } from 'lucide-react';
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
        
        {/* GitHub link - bottom right corner */}
        <a
            href="https://github.com/keyurgolani/keyurgolani.photography"
            target="_blank"
            rel="noopener noreferrer"
            className="fixed bottom-6 right-6 z-50 p-3 rounded-full bg-white/80 dark:bg-black/60 backdrop-blur-xl border border-black/10 dark:border-white/20 shadow-[0_4px_20px_rgba(0,0,0,0.1)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.5)] transition-all duration-300 hover:scale-110 hover:shadow-[0_6px_25px_rgba(0,0,0,0.15)] dark:hover:shadow-[0_6px_25px_rgba(0,0,0,0.6)] group"
            aria-label="View source on GitHub"
        >
            <Github size={20} strokeWidth={1.5} className="text-black/70 dark:text-white/70 group-hover:text-black dark:group-hover:text-white transition-colors" />
            <span className="absolute -top-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-white dark:bg-black/80 text-black dark:text-white text-xs font-medium rounded-full opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap border border-black/10 dark:border-white/10 backdrop-blur-md shadow-lg">
                View Source
            </span>
        </a>
    </main>
  );
}
