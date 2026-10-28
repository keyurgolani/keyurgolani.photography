import React from 'react';
import SiteNav from '../../components/site/SiteNav';
import { artist } from '../../data/artist';
import { aboutPortraitView } from '../../lib/siteConfig/portraitVariants';
import AboutView from './AboutView';

interface AboutPageProps {
  /** Where the portrait's variants load from: '' on the site, the draft preview's path in the curator (#16). */
  portraitBasePath?: string;
}

/** About with the host's portrait, as the site's /about and the curator's draft preview both render it. */
export default async function AboutPage({ portraitBasePath = '' }: AboutPageProps) {
  const { profile, destinations } = artist;
  const portrait = await aboutPortraitView(profile.name, { basePath: portraitBasePath });
  return (
    <>
      <SiteNav surface="about" />
      <AboutView profile={profile} portrait={portrait} destinations={destinations} />
    </>
  );
}
