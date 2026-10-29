import type { Metadata } from 'next';
import React from 'react';
import { artist } from '../../data/artist';
import { assertPublishableCopy } from '../../utils/artistProfile';
import AboutPage from './AboutPage';

// At module scope on purpose: next build evaluates this file, so provisional
// copy fails the build. Inside the component it would pass the build and
// answer /about with a 500 instead.
assertPublishableCopy(artist.profile);

export const metadata: Metadata = { title: 'About' };

// The portrait is a file on the host, read per request, so a swapped file
// shows without a build. A prerendered About would keep the one the build saw.
export const dynamic = 'force-dynamic';

export default function About() {
  return <AboutPage />;
}
