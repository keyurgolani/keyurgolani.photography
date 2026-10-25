'use client';

import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { motion, useMotionValue, useTransform, animate, type AnimationPlaybackControls } from 'framer-motion';
import ProfilePicture from './ProfilePicture';
import { HOME_LOADING_TIMEOUT_MS } from './home/homeChromeConfig';
import { usePrefersReducedMotion } from './motion/usePrefersReducedMotion';
import profileBack from '../public/assets/profile/back.png';
import profileFront from '../public/assets/profile/front.png';
import styles from './HeroReveal.module.css';

export type HeroRevealPhase = 'loading' | 'revealing' | 'settled';

interface HeroRevealProps {
  isLoading: boolean;
  onSettled: () => void;
  /** Called with each phase, the first included. */
  onPhaseChange?: (phase: HeroRevealPhase) => void;
}

/** At least two ripple cycles play before the reveal. */
const MIN_RIPPLE_MS = 2400;
/** The ripples fade this long before the mask starts to open. */
const RIPPLE_FADE_LEAD_MS = 300;
/** How long the mask takes to open from the portrait to the whole viewport. */
const REVEAL_S = 1.2;
/**
 * The intro ends within Home's 6 s loading bound, fade included, so its exit
 * starts by this long after mount whether or not the photograph has arrived.
 */
const HERO_EXIT_DEADLINE_MS = HOME_LOADING_TIMEOUT_MS - RIPPLE_FADE_LEAD_MS - REVEAL_S * 1000;

/**
 * Home's loading state on a first visit with motion: a grain overlay with
 * ripples around a centered portrait. Once loading ends, or at the exit
 * deadline if it hasn't, the portrait fades as a hole opens from the center
 * onto the photograph, and when the hole fills the viewport the intro is
 * settled and renders nothing. A return visit and reduced motion start settled.
 */
export default function HeroReveal({ isLoading, onSettled, onPhaseChange }: HeroRevealProps) {
  const reducedMotion = usePrefersReducedMotion();
  // Settled is terminal: once there, no preference change replays the intro.
  const [phase, setPhase] = useState<HeroRevealPhase>(() => (isLoading && !reducedMotion ? 'loading' : 'settled'));
  const settledRef = useRef(phase === 'settled');
  const [ripples, setRipples] = useState<number[]>([]);
  const [ripplesExiting, setRipplesExiting] = useState(false);
  const [profileRadius, setProfileRadius] = useState(160);
  const [maxRadius, setMaxRadius] = useState(2000);
  const rippleIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const rippleIdRef = useRef(0);
  const rippleWaitRef = useRef<NodeJS.Timeout | null>(null);
  const exitDeadlineRef = useRef<NodeJS.Timeout | null>(null);
  const revealTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const revealEndRef = useRef<NodeJS.Timeout | null>(null);
  const revealAnimationRef = useRef<AnimationPlaybackControls | null>(null);
  const revealInitiatedRef = useRef(!isLoading);
  const mountedRef = useRef(false);
  const notifiedRef = useRef(false);
  const mountTimeRef = useRef(Date.now());

  // Motion value for reveal progress: 0 = fully covered, 1 = fully revealed
  const revealProgress = useMotionValue(0);

  // Generate mask-image from revealProgress — expands a transparent hole from center
  const maskImage = useTransform(revealProgress, (v: number) => {
    const radius = profileRadius + v * (maxRadius - profileRadius);
    // Use a small feather (3% spread) for a soft edge on the reveal circle
    return `radial-gradient(circle ${radius}px at 50% 50%, transparent 0%, transparent 97%, black 100%)`;
  });

  const clearIntroTimers = useCallback(() => {
    for (const timer of [rippleWaitRef, exitDeadlineRef, revealTimeoutRef, revealEndRef]) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    }
    if (rippleIntervalRef.current) clearInterval(rippleIntervalRef.current);
    rippleIntervalRef.current = null;
  }, []);

  const settle = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    clearIntroTimers();
    setPhase('settled');
  }, [clearIntroTimers]);

  // No intro timer or animation outlives the component.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearIntroTimers();
      revealAnimationRef.current?.stop();
    };
  }, [clearIntroTimers]);

  // Under reduced motion the intro never paints, and one in progress ends where it is.
  useLayoutEffect(() => {
    if (!reducedMotion) return;
    clearIntroTimers();
    revealAnimationRef.current?.stop();
    settle();
  }, [reducedMotion, clearIntroTimers, settle]);

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

  // The exit, once: the ripples stop and fade, then the mask opens as the portrait fades.
  const beginExit = useCallback(() => {
    if (revealInitiatedRef.current || settledRef.current) return;
    revealInitiatedRef.current = true;
    clearIntroTimers();
    setRipplesExiting(true);
    revealTimeoutRef.current = setTimeout(() => {
      revealTimeoutRef.current = null;
      setPhase('revealing');
      revealAnimationRef.current = animate(revealProgress, 1, {
        duration: REVEAL_S,
        ease: 'easeInOut',
        onComplete: () => {
          // Reduced motion may have settled the intro mid-reveal, or Home may be gone.
          if (mountedRef.current) settle();
        },
      });
    }, RIPPLE_FADE_LEAD_MS);
    // The exit's end on the clock, too, in case the mask's last frame comes late or not at all, as in a hidden tab.
    revealEndRef.current = setTimeout(settle, RIPPLE_FADE_LEAD_MS + REVEAL_S * 1000);
  }, [clearIntroTimers, revealProgress, settle]);

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

  if (phase === 'settled') return null;

  return (
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

      {/* The portrait waits at the center while Home loads, then fades as the reveal opens. */}
      <div className={styles.portrait} data-revealing={phase === 'revealing' ? '' : undefined}>
        <ProfilePicture profileBack={profileBack} profileFront={profileFront} />
      </div>
    </>
  );
}
