import React from 'react';
import SiteNav from '../../components/site/SiteNav';
import AboutClient from './AboutClient';

export default function About() {
  return (
    <>
      {/* The default variant until #12 gives About its paper ground. The wrapper stacks the nav over the page's
          fixed z-50 portrait, which reaches up behind it on short screens. The nav itself stays in normal flow. */}
      <div className="relative z-[60]">
        <SiteNav />
      </div>
      <AboutClient />
    </>
  );
}
