import type { Metadata } from 'next';
import React from 'react';
import SiteNav from '../../components/site/SiteNav';
import { artist } from '../../data/artist';
import { aboutPortraitView } from '../../lib/siteConfig/portraitVariants';
import { assertPublishableCopy } from '../../utils/artistProfile';
import AboutView from './AboutView';

// At module scope on purpose: next build evaluates this file, so provisional
// copy fails the build. Inside the component it would pass the build and
// answer /about with a 500 instead.
assertPublishableCopy(artist.profile);

export const metadata: Metadata = { title: 'About' };

// The portrait is a file on the host, read per request, so a swapped file
// shows without a build. A prerendered About would keep the one the build saw.
export const dynamic = 'force-dynamic';

export default async function About() {
  const { profile, destinations } = artist;
  const portrait = await aboutPortraitView(profile.name);
  return (
    <>
      <SiteNav surface="about" />
      <AboutView profile={profile} portrait={portrait} destinations={destinations} />
    </>
  );
}
