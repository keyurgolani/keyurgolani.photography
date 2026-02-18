'use client';

import React from 'react';
import Link from 'next/link';
import { Images, Home, UserRound } from 'lucide-react';

interface BottomBarProps {
  children?: React.ReactNode;
}

const BottomBar: React.FC<BottomBarProps> = ({ children }) => {
  return (
    <div className="fixed bottom-0 left-0 w-full z-50 pointer-events-none">
       {/* Use pointer-events-none for container so clicks pass through to background when not on UI elements */}
       {/* But we don't want the container to block interactions, so flex layout handles positioning */}
      <div className="flex flex-col items-center justify-end w-full h-screen pb-8 pointer-events-none">
        
         {/* Children content area (e.g. Profile Picture) - Allow interactions */}
        <div className="mb-12 pointer-events-auto transition-all duration-500 ease-out transform hover:scale-105 overflow-visible">
          {children}
        </div>

        {/* Navigation Bar - Allow interactions */}
        <div className="pointer-events-auto">
             <div className="flex items-center gap-2 p-2 bg-white/80 dark:bg-black/60 backdrop-blur-xl border border-black/10 dark:border-white/20 rounded-full shadow-[0_10px_40px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_40px_rgba(0,0,0,0.6)] ring-1 ring-black/5 dark:ring-white/10 transition-transform hover:scale-[1.02] duration-300">
                
                <Link href="/" aria-label="Home" className="group relative p-3 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-all duration-300">
                    <Home size={24} strokeWidth={1.5} className="text-black/70 dark:text-white/70 group-hover:text-black dark:group-hover:text-white transition-colors" />
                    <span className="absolute -top-12 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-white dark:bg-black/80 text-black dark:text-white text-xs font-medium rounded-full opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap border border-black/10 dark:border-white/10 backdrop-blur-md shadow-lg">Home</span>
                </Link>

                <div className="w-px h-6 bg-black/10 dark:bg-white/10" />

                <Link href="/gallery" aria-label="Gallery" className="group relative p-3 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-all duration-300">
                    <Images size={24} strokeWidth={1.5} className="text-black/70 dark:text-white/70 group-hover:text-black dark:group-hover:text-white transition-colors" />
                    <span className="absolute -top-12 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-white dark:bg-black/80 text-black dark:text-white text-xs font-medium rounded-full opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap border border-black/10 dark:border-white/10 backdrop-blur-md shadow-lg">Gallery</span>
                </Link>

                <div className="w-px h-6 bg-black/10 dark:bg-white/10" />

                <Link href="/about" aria-label="About" className="group relative p-3 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-all duration-300">
                    <UserRound size={24} strokeWidth={1.5} className="text-black/70 dark:text-white/70 group-hover:text-black dark:group-hover:text-white transition-colors" />
                    <span className="absolute -top-12 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-white dark:bg-black/80 text-black dark:text-white text-xs font-medium rounded-full opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap border border-black/10 dark:border-white/10 backdrop-blur-md shadow-lg">About</span>
                </Link>
            </div>
        </div>
      </div>
    </div>
  );
};

export default BottomBar;
