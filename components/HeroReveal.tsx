'use client';

import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { motion, useMotionValue, useTransform, animate, type AnimationPlaybackControls } from 'framer-motion';
import type { AboutPortraitView } from '@/lib/siteConfig/portraitVariants';
import ProfilePicture from './ProfilePicture';
import { HOME_LOADING_TIMEOUT_MS } from './home/homeChromeConfig';
import { usePrefersReducedMotion } from './motion/usePrefersReducedMotion';
import styles from './HeroReveal.module.css';

export type HeroRevealPhase = 'loading' | 'revealing' | 'settled';

interface HeroRevealProps {
  isLoading: boolean;
  onSettled: () => void;
  /** Called with each phase, the first included. */
  onPhaseChange?: (phase: HeroRevealPhase) => void;
  /** About's portrait from the site config folder, or null when there's no usable one. */
  portrait?: AboutPortraitView | null;
}

/** At least two ripple cycles play before the reveal. */
const MIN_RIPPLE_MS = 2400;
/** The ripples fade this long before the mask starts to open. */
const RIPPLE_FADE_LEAD_MS = 300;
/** How long the mask takes to open from the portrait to the whole viewport. */
const REVEAL_S = 1.2;
/** v1.1.0's handoff: the portrait leaves the center this long after the mask starts opening, */
const LAND_DELAY_MS = 300;
/** takes this long to reach its place above the bottom, */
const LAND_S = 0.8;
/** on the project's standard easing, */
const LAND_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
/** and the intro settles this long after it lands. */
const SETTLE_AFTER_LANDING_MS = 50;
/** The exit, from the ripples' fade to the settle: the mask's 1.2 s, or the landing, whichever ends later. */
const EXIT_MS = RIPPLE_FADE_LEAD_MS + Math.max(REVEAL_S * 1000, LAND_DELAY_MS + LAND_S * 1000 + SETTLE_AFTER_LANDING_MS);
/**
 * The intro ends within Home's 6 s loading bound, exit included, so its exit
 * starts by this long after mount whether or not the photograph has arrived.
 */
const HERO_EXIT_DEADLINE_MS = HOME_LOADING_TIMEOUT_MS - EXIT_MS;
/** v1.1.0: the badge stays this long once it's in place, then shows and hides with Home's chrome. */
export const BADGE_LINGER_MS = 3000;

/**
 * The portrait's transform for landing progress `p`: from the viewport's
 * center at full size to 280 px above its bottom at 0.85, v1.1.0's place.
 */
const landingTransform = (p: number) => `translate(-50%, -50%) translateY(calc(${p} * (50dvh - 280px))) scale(${1 - 0.15 * p})`;

/**
 * Home's loading state on a first visit with motion: a grain overlay with
 * ripples around About's portrait at the center. Once loading ends, or at
 * the exit deadline if it hasn't, a hole opens from the center onto the
 * photograph, and the portrait glides down and shrinks into its place above
 * the bottom of the screen, v1.1.0's handoff. There it stays as Home's badge:
 * for 3 s, then whenever Home's chrome shows. A return visit starts with the
 * badge in place, and reduced motion fades it in there once loading ends.
 * With no usable portrait the intro plays without one and there's no badge.
 */
export default function HeroReveal({ isLoading, onSettled, onPhaseChange, portrait = null }: HeroRevealProps) {
  const reducedMotion = usePrefersReducedMotion();
  // Settled is terminal: once there, no preference change replays the intro.
  const [phase, setPhase] = useState<HeroRevealPhase>(() => (isLoading && !reducedMotion ? 'loading' : 'settled'));
  const settledRef = useRef(phase === 'settled');
  const [ripples, setRipples] = useState<number[]>([]);
  const [ripplesExiting, setRipplesExiting] = useState(false);
  const [profileRadius, setProfileRadius] = useState(160);
  const [maxRadius, setMaxRadius] = useState(2000);
  const [portraitFailed, setPortraitFailed] = useState(false);
  // The badge is in place: it landed, or a return visit or reduced motion put it there.
  const [landed, setLanded] = useState(phase === 'settled' && !isLoading);
  // Already in place at mount, as on a return visit, it shows at once, as v1.1.0's did, with no fade in.
  const [lingering, setLingering] = useState(phase === 'settled' && !isLoading);
  const rippleIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const rippleIdRef = useRef(0);
  const rippleWaitRef = useRef<NodeJS.Timeout | null>(null);
  const exitDeadlineRef = useRef<NodeJS.Timeout | null>(null);
  const revealTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const landTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const landedTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const revealEndRef = useRef<NodeJS.Timeout | null>(null);
  const revealAnimationRef = useRef<AnimationPlaybackControls | null>(null);
  const landAnimationRef = useRef<AnimationPlaybackControls | null>(null);
  const revealInitiatedRef = useRef(!isLoading);
  const mountedRef = useRef(false);
  const notifiedRef = useRef(false);
  const mountTimeRef = useRef(Date.now());

  const showPortrait = portrait !== null && !portraitFailed;

  // Motion value for reveal progress: 0 = fully covered, 1 = fully revealed
  const revealProgress = useMotionValue(0);
  // The portrait's way from the center (0) to its place as the badge (1).
  const landing = useMotionValue(phase === 'settled' ? 1 : 0);
  const portraitTransform = useTransform(landing, landingTransform);

  // Generate mask-image from revealProgress — expands a transparent hole from center.
  // With no portrait over the center, the hole starts closed.
  const startRadius = showPortrait ? profileRadius : 0;
  const maskImage = useTransform(revealProgress, (v: number) => {
    const radius = startRadius + v * (maxRadius - startRadius);
    // Use a small feather (3% spread) for a soft edge on the reveal circle
    return `radial-gradient(circle ${radius}px at 50% 50%, transparent 0%, transparent 97%, black 100%)`;
  });

  const clearIntroTimers = useCallback(() => {
    for (const timer of [rippleWaitRef, exitDeadlineRef, revealTimeoutRef, landTimeoutRef, landedTimeoutRef, revealEndRef]) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    }
    if (rippleIntervalRef.current) clearInterval(rippleIntervalRef.current);
    rippleIntervalRef.current = null;
  }, []);

  // The intro's end, however it comes: the portrait is in its place, and the grain and ripples go.
  const settle = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    clearIntroTimers();
    revealAnimationRef.current?.stop();
    landAnimationRef.current?.stop();
    landing.set(1);
    setPhase('settled');
    // Reduced motion before the exit puts the badge in place only once loading ends.
    if (revealInitiatedRef.current) setLanded(true);
  }, [clearIntroTimers, landing]);

  // No intro timer or animation outlives the component.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearIntroTimers();
      revealAnimationRef.current?.stop();
      landAnimationRef.current?.stop();
    };
  }, [clearIntroTimers]);

  // Under reduced motion the intro never paints, and one in progress ends where it is.
  useLayoutEffect(() => {
    if (!reducedMotion) return;
    settle();
  }, [reducedMotion, settle]);

  // Settled without the handoff, the badge takes its place once loading is over.
  useEffect(() => {
    if (phase === 'settled' && !isLoading) setLanded(true);
  }, [phase, isLoading]);

  // In place, the badge stays a while before it follows the chrome.
  useEffect(() => {
    if (!landed) return;
    setLingering(true);
    const timer = setTimeout(() => setLingering(false), BADGE_LINGER_MS);
    return () => clearTimeout(timer);
  }, [landed]);

  useEffect(() => {
    onPhaseChange?.(phase);
  }, [phase, onPhaseChange]);

  // Tell Home once, when the intro ends or turns out not to be needed.
  useEffect(() => {
    if (phase !== 'settled' || notifiedRef.current) return;
    notifiedRef.current = true;
    onSettled();
  }, [phase, onSettled]);

  // The reveal opens from the portrait's size to the viewport's diagonal.
  useEffect(() => {
    setProfileRadius(window.innerWidth >= 768 ? 160 : 128);
    setMaxRadius(Math.ceil(Math.sqrt(window.innerWidth ** 2 + window.innerHeight ** 2)));
  }, []);

  // Spawn ripple rings during loading phase
  useEffect(() => {
    if (phase !== 'loading' || reducedMotion) return;

    // Spawn first ripple immediately
    rippleIdRef.current += 1;
    setRipples([rippleIdRef.current]);

    rippleIntervalRef.current = setInterval(() => {
      rippleIdRef.current += 1;
      setRipples(prev => {
        const next = [...prev, rippleIdRef.current];
        return next.length > 5 ? next.slice(-5) : next;
      });
    }, 1200);

    return () => {
      if (rippleIntervalRef.current) clearInterval(rippleIntervalRef.current);
    };
  }, [phase, reducedMotion]);

  // Clean up completed ripple animations
  const handleRippleComplete = useCallback((id: number) => {
    setRipples(prev => prev.filter(r => r !== id));
  }, []);

  // The exit, once: the ripples stop and fade, then the mask opens, and the portrait glides to its place.
  const beginExit = useCallback(() => {
    if (revealInitiatedRef.current || settledRef.current) return;
    revealInitiatedRef.current = true;
    clearIntroTimers();
    setRipplesExiting(true);
    revealTimeoutRef.current = setTimeout(() => {
      revealTimeoutRef.current = null;
      setPhase('revealing');
      revealAnimationRef.current = animate(revealProgress, 1, { duration: REVEAL_S, ease: 'easeInOut' });
      landTimeoutRef.current = setTimeout(() => {
        landTimeoutRef.current = null;
        landAnimationRef.current = animate(landing, 1, {
          duration: LAND_S,
          ease: LAND_EASE,
          onComplete: () => {
            // Reduced motion may have settled the intro mid-landing, or Home may be gone.
            if (!mountedRef.current || settledRef.current) return;
            landedTimeoutRef.current = setTimeout(settle, SETTLE_AFTER_LANDING_MS);
          },
        });
      }, LAND_DELAY_MS);
    }, RIPPLE_FADE_LEAD_MS);
    // The exit's end on the clock, too, in case an animation's last frame comes late or not at all, as in a hidden tab.
    revealEndRef.current = setTimeout(settle, EXIT_MS);
  }, [clearIntroTimers, revealProgress, landing, settle]);

  // Loading ending starts the exit once at least two ripple cycles have played.
  useEffect(() => {
    if (isLoading || reducedMotion || revealInitiatedRef.current || settledRef.current) return;
    const waitForRipples = Math.max(0, MIN_RIPPLE_MS - (Date.now() - mountTimeRef.current));
    rippleWaitRef.current = setTimeout(beginExit, waitForRipples);
    return () => {
      if (rippleWaitRef.current) clearTimeout(rippleWaitRef.current);
      rippleWaitRef.current = null;
    };
  }, [isLoading, reducedMotion, beginExit]);

  // Loaded or not, the exit starts by the deadline, so nothing of the intro paints after 6 s.
  useEffect(() => {
    if (reducedMotion || revealInitiatedRef.current || settledRef.current) return;
    exitDeadlineRef.current = setTimeout(beginExit, Math.max(0, mountTimeRef.current + HERO_EXIT_DEADLINE_MS - Date.now()));
    return () => {
      if (exitDeadlineRef.current) clearTimeout(exitDeadlineRef.current);
      exitDeadlineRef.current = null;
    };
  }, [reducedMotion, beginExit]);

  const handleUnusable = useCallback(() => setPortraitFailed(true), []);

  if (phase === 'settled' && !showPortrait) return null;

  return (
    <>
      {phase !== 'settled' && (
        <>
          {/* SVG Filter Definition (hidden, referenced by CSS) */}
          <svg style={{ position: 'absolute', width: 0, height: 0 }} aria-hidden="true">
            <defs>
              <filter id="grain-filter" x="0%" y="0%" width="100%" height="100%">
                {/* Fine fractal noise — outputs raw grain texture */}
                <feTurbulence
                  type="fractalNoise"
                  baseFrequency="0.8"
                  numOctaves={4}
                  stitchTiles="stitch"
                />
                <feColorMatrix type="saturate" values="0" />
              </filter>
            </defs>
          </svg>

          {/* Grain Overlay — covers viewport, hole expands via mask-image */}
          <motion.div
            className={styles.grainOverlay}
            style={{
              WebkitMaskImage: maskImage,
              maskImage: maskImage,
            }}
          >
            {/* Solid themed background */}
            <div className={styles.grainBackground} />
            {/* Grain texture layer — opacity controlled per theme in CSS */}
            <div className={styles.grainTexture} />
          </motion.div>

          {/* Ripple Glows — soft radial pulses, faded out as a group on exit */}
          <div
            className={styles.ripples}
            style={{
              opacity: ripplesExiting ? 0 : 1,
              transition: 'opacity 0.5s ease-out',
            }}
          >
            {ripples.map(id => (
              <motion.div
                key={id}
                style={{
                  position: 'fixed',
                  top: '50%',
                  left: '50%',
                  width: profileRadius * 2,
                  height: profileRadius * 2,
                  marginLeft: -profileRadius,
                  marginTop: -profileRadius,
                  borderRadius: '50%',
                  background: 'radial-gradient(circle, transparent 40%, var(--primary-color) 55%, transparent 70%)',
                  filter: 'blur(8px)',
                  zIndex: 41,
                  pointerEvents: 'none' as const,
                }}
                initial={{ scale: 1, opacity: 0.3 }}
                animate={{ scale: 3.5, opacity: 0 }}
                transition={{ duration: 2, ease: 'easeOut' }}
                onAnimationComplete={() => handleRippleComplete(id)}
              />
            ))}
          </div>
        </>
      )}

      {/* The portrait: one element from the center to its place, so the handoff never restarts it. */}
      {showPortrait && (
        <motion.div
          className={phase === 'settled' ? styles.badge : styles.portrait}
          style={{ transform: portraitTransform }}
          data-home-badge={phase === 'settled' ? '' : undefined}
          data-landed={phase === 'settled' && landed ? '' : undefined}
          data-lingering={phase === 'settled' && landed && lingering ? '' : undefined}
        >
          <ProfilePicture portrait={portrait} still={reducedMotion} onUnusable={handleUnusable} />
        </motion.div>
      )}
    </>
  );
}
