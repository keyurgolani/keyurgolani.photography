import type { Metadata } from 'next';
import React from 'react';
import SiteNav from '../../components/site/SiteNav';
import AboutClient from './AboutClient';

export const metadata: Metadata = { title: 'About' };

export default function About() {
  return (
    <>
      {/* The default variant until #12 gives About its paper ground. */}
      <SiteNav />
      <AboutClient />
    </>
  );
}
