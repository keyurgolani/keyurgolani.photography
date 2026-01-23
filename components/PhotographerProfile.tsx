'use client';

import React from 'react';
import SocialProfileCard from './SocialProfileCard';

interface PhotographerProfileProps {
    className?: string;
}

// Cards positioned like they're scattered on a desk - random positions and angles
// Positions are responsive: different placements for mobile vs desktop
const cardPositions = [
    { 
        platform: 'instagram' as const, 
        handle: 'iserialclicker', 
        url: 'https://www.instagram.com/iserialclicker',
        embedUrl: 'https://www.instagram.com/iserialclicker/embed',
        // Top left, tilted left
        className: 'top-[12%] left-[2%] sm:top-[8%] sm:left-[2%] md:top-[6%] md:left-[3%] lg:top-[5%] lg:left-[4%] xl:left-[6%] 2xl:left-[8%] 3xl:left-[10%]',
        rotation: '-8deg'
    },
    { 
        platform: '500px' as const, 
        handle: 'iserialclicker', 
        url: 'https://500px.com/p/iserialclicker',
        embedUrl: 'https://500px.com/p/iserialclicker',
        // Top right, tilted right
        className: 'top-[38%] right-[2%] sm:top-[25%] sm:right-[2%] md:top-[12%] md:right-[3%] lg:top-[5%] lg:right-[4%] xl:right-[6%] 2xl:right-[8%] 3xl:right-[10%]',
        rotation: '6deg'
    },
    { 
        platform: 'flickr' as const, 
        handle: 'iserialclicker', 
        url: 'https://www.flickr.com/photos/iserialclicker',
        embedUrl: 'https://www.flickr.com/photos/iserialclicker',
        // Bottom left on all viewports, slight tilt
        className: 'bottom-[38%] left-[2%] sm:bottom-[25%] sm:left-[2%] md:bottom-[18%] md:left-[20%] lg:bottom-[15%] lg:left-[25%] xl:left-[28%] 2xl:left-[30%] 3xl:left-[32%]',
        rotation: '4deg'
    },
];

export default function PhotographerProfile({ className = '' }: PhotographerProfileProps) {
    return (
        <div className={`absolute inset-0 overflow-hidden pointer-events-none ${className}`}>
            {/* Scattered social profile cards */}
            {cardPositions.map((card) => (
                <div key={card.platform} className="pointer-events-auto">
                    <SocialProfileCard
                        platform={card.platform}
                        handle={card.handle}
                        url={card.url}
                        embedUrl={card.embedUrl}
                        className={card.className}
                        style={{ transform: `rotate(${card.rotation})` }}
                    />
                </div>
            ))}
        </div>
    );
}
