'use client';

import React, { createContext, useContext } from 'react';
import type { AboutPortraitView } from '@/lib/siteConfig/portraitVariants';

/**
 * STAGE 1 PROTOTYPE. What Home's loader shows: About's one portrait from the
 * site config folder (#84), or null for none, and whether the single image
 * keeps today's card tilt. The page reads both on the server, so the first
 * render already has them.
 */
export interface LoaderPortraitValue {
  portrait: AboutPortraitView | null;
  tilt: boolean;
}

const LoaderPortraitContext = createContext<LoaderPortraitValue>({ portrait: null, tilt: false });

export function LoaderPortraitProvider({ value, children }: { value: LoaderPortraitValue; children: React.ReactNode }) {
  return <LoaderPortraitContext.Provider value={value}>{children}</LoaderPortraitContext.Provider>;
}

export const useLoaderPortrait = () => useContext(LoaderPortraitContext);
