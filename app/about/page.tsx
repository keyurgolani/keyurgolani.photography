import type { Metadata } from 'next';
import React from 'react';
import { artist } from '../../data/artist';
import { getSiteOrigin } from '../../lib/site/config';
import { assertPublishableCopy } from '../../utils/artistProfile';
import AboutPage from './AboutPage';

// At module scope on purpose: next build evaluates this file, so provisional
// copy fails the build. Inside the component it would pass the build and
// answer /about with a 500 instead.
assertPublishableCopy(artist.profile);

/**
 * About's title, the approved statement heading as its description (#12,
 * "A curious soul"), and its canonical path, through the root layout's title
 * template and metadataBase. Per request, since SITE_URL is: without a valid
 * one the base is localhost, so the canonical link is left out, as on the
 * series and Viewer pages.
 */
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: 'About',
    description: artist.profile.statementHeading,
    ...(getSiteOrigin() !== null && { alternates: { canonical: '/about' } }),
  };
}

// The portrait is a file on the host, read per request, so a swapped file
// shows without a build. A prerendered About would keep the one the build saw.
export const dynamic = 'force-dynamic';

export default function About() {
  return <AboutPage />;
}
