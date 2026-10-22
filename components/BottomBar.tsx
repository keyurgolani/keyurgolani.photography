'use client';

import React from 'react';
import Link from 'next/link';
import { Images, Home, UserRound, type LucideIcon } from 'lucide-react';
import { motion } from 'framer-motion';
import { usePrefersReducedMotion } from './motion/usePrefersReducedMotion';
import { DISMISSED_LABEL_STYLE, useDismissibleLabel } from './useDismissibleLabel';

interface BottomBarProps {
  children?: React.ReactNode;
  visible?: boolean;
}

/**
 * On a short screen Home's slideshow controls sit just above the pill, so a
 * label shows under its icon instead, clear of the link's focus ring, and its
 * bridge reaches up past the 0.5rem gap into the link, so a pointer moving
 * down off the icon's centre stays on the round link or the bridge. The query
 * is the one HomeSequenceControls moves the controls under.
 */
const LABEL_BELOW_ON_SHORT_SCREENS =
  '[@media(max-width:849px)_and_(max-height:519px)]:top-[calc(100%+0.5rem)] [@media(max-width:849px)_and_(max-height:519px)]:after:top-auto [@media(max-width:849px)_and_(max-height:519px)]:after:bottom-full [@media(max-width:849px)_and_(max-height:519px)]:after:h-3';

/**
 * A Primary link with a label that hover or keyboard focus shows. The label
 * takes the pointer only while shown, so a hidden one never catches a tap
 * meant for the page under it, and Escape hides it. Its ::after bridges the
 * gap down to the link, so the pointer can cross onto it without the link
 * losing :hover.
 */
const NavLink: React.FC<{ href: string; label: string; icon: LucideIcon }> = ({ href, label, icon: Icon }) => {
  const { dismissed, handlers } = useDismissibleLabel();
  return (
    <Link href={href} aria-label={label} className="group relative p-3 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors duration-300" {...handlers}>
      <Icon size={24} strokeWidth={1.5} className="text-black/70 dark:text-white/70 group-hover:text-black dark:group-hover:text-white transition-colors" />
      <span className={`absolute -top-12 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-white dark:bg-black/80 text-black dark:text-white text-xs font-medium rounded-full opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-visible:opacity-100 group-focus-visible:pointer-events-auto transition-opacity whitespace-nowrap border border-black/10 dark:border-white/10 backdrop-blur-md shadow-lg after:absolute after:inset-x-0 after:top-full after:h-5 ${LABEL_BELOW_ON_SHORT_SCREENS}`} style={dismissed ? DISMISSED_LABEL_STYLE : undefined}>{label}</span>
    </Link>
  );
};

const BottomBar: React.FC<BottomBarProps> = ({ children, visible = true }) => {
  // Under reduced motion the bar appears in place, at once.
  const reducedMotion = usePrefersReducedMotion();
  return (
    <motion.div
      className="fixed bottom-0 left-0 w-full z-50 pointer-events-none"
      initial={false}
      animate={{
        y: visible || reducedMotion ? 0 : '100%',
        opacity: visible ? 1 : 0,
      }}
      transition={reducedMotion ? { duration: 0 } : { duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
    >
       {/* Use pointer-events-none for container so clicks pass through to background when not on UI elements */}
       {/* But we don't want the container to block interactions, so flex layout handles positioning */}
      <div className="flex flex-col items-center justify-end w-full h-screen pb-8 pointer-events-none">
        
         {/* Children content area (e.g. Profile Picture) - Allow interactions */}
        <div className="mb-12 pointer-events-auto transition-all duration-500 ease-out transform motion-safe:hover:scale-105 overflow-visible">
          {children}
        </div>

        {/* Navigation Bar - Allow interactions */}
        <div className="pointer-events-auto">
          <nav aria-label="Primary">
             <div className="flex items-center gap-2 p-2 bg-white/80 dark:bg-black/60 backdrop-blur-xl border border-black/10 dark:border-white/20 rounded-full shadow-[0_10px_40px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_40px_rgba(0,0,0,0.6)] ring-1 ring-black/5 dark:ring-white/10 transition-transform motion-safe:hover:scale-[1.02] duration-300">
                
                <NavLink href="/gallery" label="Gallery" icon={Images} />

                <div className="w-px h-6 bg-black/10 dark:bg-white/10" />

                <NavLink href="/" label="Home" icon={Home} />

                <div className="w-px h-6 bg-black/10 dark:bg-white/10" />

                <NavLink href="/about" label="About" icon={UserRound} />
            </div>
          </nav>
        </div>
      </div>
    </motion.div>
  );
};

export default BottomBar;
