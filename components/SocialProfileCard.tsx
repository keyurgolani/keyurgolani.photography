'use client';

import React from 'react';

interface SocialProfileCardProps {
    platform: 'instagram' | '500px' | 'flickr';
    handle: string;
    url: string;
    embedUrl?: string;
    style?: React.CSSProperties;
    className?: string;
}

const platformConfig = {
    instagram: {
        name: 'Instagram',
        gradient: 'from-purple-500 via-pink-500 to-orange-400',
        headerGradient: 'from-purple-600 via-pink-500 to-orange-400',
        shadowColor: 'shadow-purple-500/20',
        bgColor: 'from-neutral-900 via-neutral-800 to-neutral-900',
        accentColor: '#E1306C',
        buttonText: 'View on Instagram',
    },
    '500px': {
        name: '500px',
        gradient: 'from-cyan-400 to-blue-500',
        headerGradient: 'from-cyan-500 to-blue-600',
        shadowColor: 'shadow-cyan-500/20',
        bgColor: 'from-neutral-900 to-black',
        accentColor: '#0099e5',
        buttonText: 'View on 500px',
    },
    flickr: {
        name: 'Flickr',
        gradient: 'from-pink-500 to-blue-600',
        headerGradient: 'from-pink-500 to-blue-600',
        shadowColor: 'shadow-pink-500/20',
        bgColor: 'from-neutral-800 to-neutral-900',
        accentColor: '#0063dc',
        buttonText: 'View on Flickr',
    },
};

// Instagram logo component
function InstagramLogo({ className }: { className?: string }) {
    return (
        <div className={`rounded-2xl bg-gradient-to-br from-purple-600 via-pink-500 to-orange-400 p-3 sm:p-4 md:p-5 lg:p-6 ${className}`}>
            <div className="w-full h-full border-[2px] sm:border-[3px] md:border-4 border-white rounded-lg sm:rounded-xl relative">
                <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-1/2 h-1/2 border-[2px] sm:border-[3px] md:border-4 border-white rounded-full" />
                </div>
                <div className="absolute top-1 right-1 sm:top-1.5 sm:right-1.5 md:top-2 md:right-2 w-1 h-1 sm:w-1.5 sm:h-1.5 md:w-2 md:h-2 bg-white rounded-full" />
            </div>
        </div>
    );
}

// 500px logo component
function FiveHundredPxLogo({ className }: { className?: string }) {
    return (
        <div className={`flex items-center justify-center ${className}`}>
            <span className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-bold text-white">500</span>
            <span className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-light text-cyan-400">px</span>
        </div>
    );
}

// Flickr logo component
function FlickrLogo({ className }: { className?: string }) {
    return (
        <div className={`flex gap-1.5 sm:gap-2 md:gap-3 ${className}`}>
            <div className="w-6 h-6 sm:w-8 sm:h-8 md:w-10 md:h-10 lg:w-14 lg:h-14 rounded-full bg-[#0063dc]" />
            <div className="w-6 h-6 sm:w-8 sm:h-8 md:w-10 md:h-10 lg:w-14 lg:h-14 rounded-full bg-[#ff0084]" />
        </div>
    );
}

export default function SocialProfileCard({ platform, handle, url, style, className = '' }: SocialProfileCardProps) {
    const config = platformConfig[platform];

    return (
        <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            style={style}
            className={`group absolute block 
                w-36 h-52 
                sm:w-44 sm:h-64 
                md:w-56 md:h-80 
                lg:w-72 lg:h-[26rem] 
                xl:w-80 xl:h-[30rem] 
                2xl:w-96 2xl:h-[36rem]
                3xl:w-[26rem] 3xl:h-[40rem]
                4xl:w-[30rem] 4xl:h-[46rem]
                transition-all duration-500 hover:z-50 hover:scale-105 ${className}`}
        >
            {/* Card with shadow and border */}
            <div className={`relative w-full h-full rounded-xl overflow-hidden bg-neutral-900 border border-white/10 shadow-2xl ${config.shadowColor} hover:shadow-3xl transition-shadow duration-300`}>
                {/* Gradient header bar */}
                <div className={`absolute top-0 left-0 right-0 h-6 sm:h-7 md:h-8 bg-gradient-to-r ${config.headerGradient} flex items-center px-2 sm:px-3 gap-1 sm:gap-2`}>
                    <div className="flex gap-1 sm:gap-1.5">
                        <div className="w-1.5 h-1.5 sm:w-2 sm:h-2 md:w-2.5 md:h-2.5 rounded-full bg-white/30" />
                        <div className="w-1.5 h-1.5 sm:w-2 sm:h-2 md:w-2.5 md:h-2.5 rounded-full bg-white/30" />
                        <div className="w-1.5 h-1.5 sm:w-2 sm:h-2 md:w-2.5 md:h-2.5 rounded-full bg-white/30" />
                    </div>
                    <span className="text-white/90 text-[10px] sm:text-xs font-medium ml-1 sm:ml-2 truncate">{config.name} - @{handle}</span>
                </div>
                
                {/* Static branded preview */}
                <div className={`absolute top-6 sm:top-7 md:top-8 left-0 right-0 bottom-0 bg-gradient-to-br ${config.bgColor} flex flex-col items-center justify-center p-4`}>
                    {/* Platform-specific logo */}
                    <div className="mb-4 sm:mb-6">
                        {platform === 'instagram' && (
                            <InstagramLogo className="w-12 h-12 sm:w-16 sm:h-16 md:w-20 md:h-20 lg:w-24 lg:h-24" />
                        )}
                        {platform === '500px' && (
                            <FiveHundredPxLogo />
                        )}
                        {platform === 'flickr' && (
                            <FlickrLogo />
                        )}
                    </div>
                    
                    {/* Handle */}
                    <p className="text-white/90 text-sm sm:text-base md:text-lg lg:text-xl font-semibold mb-1">@{handle}</p>
                    <p className="text-white/50 text-xs sm:text-sm mb-4 sm:mb-6 text-center">Photography Portfolio</p>
                    
                    {/* CTA Button */}
                    <div className={`px-3 py-1.5 sm:px-4 sm:py-2 md:px-5 md:py-2.5 rounded-full bg-gradient-to-r ${config.gradient} text-white text-xs sm:text-sm font-medium shadow-lg`}>
                        {config.buttonText}
                    </div>
                </div>
                
                {/* Hover overlay */}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors duration-300 flex items-center justify-center opacity-0 group-hover:opacity-100">
                    <span className="px-3 py-1.5 sm:px-4 sm:py-2 bg-white/90 text-black text-xs sm:text-sm font-medium rounded-full shadow-lg">
                        Visit Profile →
                    </span>
                </div>
            </div>
        </a>
    );
}
