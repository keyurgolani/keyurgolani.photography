'use client';

import React from 'react';
import ExternalLinks from '../../components/ExternalLinks';
import ProfilePicture from '../../components/ProfilePicture';
import { artist } from '../../data/artist';
import profileBack from '../../public/assets/profile/back.png';
import profileFront from '../../public/assets/profile/front.png';
import styles from './about.module.css';

export default function AboutClient() {
  return (
    <main className={styles.root}>
      <div data-testid="about-portrait" className={styles.portrait}>
        <ProfilePicture profileBack={profileBack} profileFront={profileFront} className="!w-full !h-full" />
      </div>

      <div data-testid="about-heading" className="text-center">
        <h1 className="text-3xl sm:text-4xl font-bold text-white mb-1 font-primary drop-shadow-lg">Keyur Golani</h1>
        <p className="text-lg text-white/70 font-light tracking-wide drop-shadow-md">aka ISerialClicker</p>
      </div>

      <ExternalLinks destinations={artist.destinations} />
    </main>
  );
}
