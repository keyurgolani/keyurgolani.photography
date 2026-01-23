'use client';

import React from 'react';
import Image, { StaticImageData } from 'next/image';
import ParallaxCard from './ParallaxCard';

interface ProfilePictureProps {
  profileBack: string | StaticImageData;
  profileFront: string | StaticImageData;
  className?: string;
}

const ProfilePicture: React.FC<ProfilePictureProps> = ({
  profileBack,
  profileFront,
  className = '',
}) => {
  return (
    <div className={`w-64 h-64 md:w-80 md:h-80 relative ${className}`}>
      <ParallaxCard
        cardOffset={50}
        baseLayerOffset={40}
        layerOffsetMultiplier={60}
        className="w-full h-full"
      >
        <div className="relative w-full h-full p-2">
            <Image
            src={profileBack}
            alt="Profile Background"
            width={320}
            height={320}
            className="rounded-full object-cover shadow-lg ring-4 ring-white/30 dark:ring-white/10"
            priority
            />
        </div>
        <div className="relative w-full h-full p-2">
            <Image
                src={profileFront}
                alt="Profile Front"
                width={320}
                height={320}
                className="rounded-full object-cover drop-shadow-2xl ring-4 ring-white/30 dark:ring-white/10"
                priority
            />
        </div>
      </ParallaxCard>
    </div>
  );
};

export default ProfilePicture;
