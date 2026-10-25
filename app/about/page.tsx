import type { Metadata } from 'next';
import React from 'react';
import SiteNav from '../../components/site/SiteNav';
import { artist } from '../../data/artist';
import portraitImage from '../../data/artistPortraitImage';
import { assertPublishableCopy } from '../../utils/artistProfile';
import AboutView from './AboutView';

// At module scope on purpose: next build evaluates this file, so provisional
// copy fails the build. Inside the component it would pass the build and
// answer /about with a 500 instead.
assertPublishableCopy(artist.profile);

export const metadata: Metadata = { title: 'About' };

export default function About() {
  const { profile, destinations } = artist;
  return (
    <>
      <SiteNav surface="about" />
      <AboutView profile={profile} portraitSrc={portraitImage} destinations={destinations} />
    </>
  );
}
