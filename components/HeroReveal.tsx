'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, useMotionValue, useTransform, animate, useAnimationControls } from 'framer-motion';
import ProfilePicture from './ProfilePicture';
import profileBack from '../public/assets/profile/back.png';
import profileFront from '../public/assets/profile/front.png';
import styles from './HeroReveal.module.css';

type Phase = 'loading' | 'revealing' | 'settled';

interface HeroRevealProps {
  isLoading: boolean;
  onSettled: () => void;
}

// Project's standard easing
const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

// Match RevealingContents auto-hide timeout
const AUTO_HIDE_TIMEOUT = parseInt(
  process.env.NEXT_PUBLIC_UI_AUTO_HIDE_TIMEOUT || '3000',
  10
);

export default function HeroReveal({ isLoading, onSettled }: HeroRevealProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [ripples, setRipples] = useState<number[]>([]);
  const [ripplesExiting, setRipplesExiting] = useState(false);
  const [profileRadius, setProfileRadius] = useState(160);
  const [maxRadius, setMaxRadius] = useState(2000);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [profileVisible, setProfileVisible] = useState(true);
  const rippleIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const rippleIdRef = useRef(0);
  const rippleWaitRef = useRef<NodeJS.Timeout | null>(null);
  const revealTimeout1Ref = useRef<NodeJS.Timeout | null>(null);
  const revealTimeout2Ref = useRef<NodeJS.Timeout | null>(null);
  const revealInitiatedRef = useRef(false);
  const mountTimeRef = useRef(Date.now());
  const profileControls = useAnimationControls();

  // Motion value for reveal progress: 0 = fully covered, 1 = fully revealed
  const revealProgress = useMotionValue(0);

  // Generate mask-image from revealProgress — expands a transparent hole from center
  const maskImage = useTransform(revealProgress, (v: number) => {
    const radius = profileRadius + v * (maxRadius - profileRadius);
    // Use a small feather (3% spread) for a soft edge on the reveal circle
    return `radial-gradient(circle ${radius}px at 50% 50%, transparent 0%, transparent 97%, black 100%)`;
  });

  // Measure viewport and profile size on mount (SSR-safe)
  // Also convert profile position to pixel values so Framer Motion can interpolate
  useEffect(() => {
    const isMd = window.innerWidth >= 768;
    setProfileRadius(isMd ? 160 : 128);
    setMaxRadius(Math.ceil(Math.sqrt(window.innerWidth ** 2 + window.innerHeight ** 2)));
    setReducedMotion(window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    // Convert initial centering position from percentages to pixels
    // so profileControls.start() can interpolate to pixel targets later
    profileControls.set({
      top: window.innerHeight / 2,
      left: window.innerWidth / 2,
    });
  }, [profileControls]);

  // If reduced motion, skip to settled immediately
  useEffect(() => {
    if (reducedMotion) {
      setPhase('settled');
      onSettled();
    }
  }, [reducedMotion, onSettled]);

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

  // Trigger reveal when isLoading becomes false
  // Uses a ref to track initiation so `phase` isn't in the dependency array —
  // otherwise setPhase('revealing') would trigger cleanup that cancels our timeouts
  useEffect(() => {
    if (!isLoading && !revealInitiatedRef.current && !reducedMotion) {
      revealInitiatedRef.current = true;

      // Ensure at least 2 ripple cycles (2400ms) have played before revealing
      const elapsed = Date.now() - mountTimeRef.current;
      const minDisplayTime = 2400;
      const waitForRipples = Math.max(0, minDisplayTime - elapsed);

      // Delay the reveal if images loaded too quickly
      rippleWaitRef.current = setTimeout(() => {
        // Stop spawning new ripples and fade existing ones out
        if (rippleIntervalRef.current) clearInterval(rippleIntervalRef.current);
        setRipplesExiting(true);

        // Start reveal shortly after fade begins — they overlap slightly
        revealTimeout1Ref.current = setTimeout(() => {
          setPhase('revealing');

          // Animate the mask-image reveal (expanding hole from center outward)
          animate(revealProgress, 1, { duration: 1.2, ease: 'easeInOut' });

          // Animate profile photo from center to bottom position (starts 0.3s after reveal)
          // Use pixel values — Framer Motion can't interpolate between '%' and 'calc()'
          revealTimeout2Ref.current = setTimeout(() => {
            profileControls.start({
              top: window.innerHeight - 280,
              left: window.innerWidth / 2,
              scale: 0.85,
              transition: { duration: 0.8, ease: EASE_OUT },
            }).then(() => {
              setTimeout(() => {
                setPhase('settled');
                onSettled();
              }, 50);
            });
          }, 300);
        }, 300);
      }, waitForRipples);
    }

    return () => {
      if (rippleWaitRef.current) clearTimeout(rippleWaitRef.current);
      if (revealTimeout1Ref.current) clearTimeout(revealTimeout1Ref.current);
      if (revealTimeout2Ref.current) clearTimeout(revealTimeout2Ref.current);
    };
  }, [isLoading, reducedMotion, revealProgress, profileControls, onSettled]);

  // Auto-hide profile photo after settling (mirrors RevealingContents behavior)
  useEffect(() => {
    if (phase !== 'settled') return;

    let hideTimeout: NodeJS.Timeout;
    const lastMousePos = { x: 0, y: 0 };
    let hasInitialPos = false;

    const handleActivity = () => {
      setProfileVisible(true);
      clearTimeout(hideTimeout);
      hideTimeout = setTimeout(() => setProfileVisible(false), AUTO_HIDE_TIMEOUT);
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!hasInitialPos) {
        lastMousePos.x = e.clientX;
        lastMousePos.y = e.clientY;
        hasInitialPos = true;
        return;
      }
      const dx = e.clientX - lastMousePos.x;
      const dy = e.clientY - lastMousePos.y;
      if (Math.sqrt(dx * dx + dy * dy) < 100) return;
      lastMousePos.x = e.clientX;
      lastMousePos.y = e.clientY;
      handleActivity();
    };

    // Start the initial auto-hide timer
    hideTimeout = setTimeout(() => setProfileVisible(false), AUTO_HIDE_TIMEOUT);

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('touchstart', handleActivity);
    window.addEventListener('click', handleActivity);
    window.addEventListener('keydown', handleActivity);
    window.addEventListener('scroll', handleActivity);

    return () => {
      clearTimeout(hideTimeout);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('touchstart', handleActivity);
      window.removeEventListener('click', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      window.removeEventListener('scroll', handleActivity);
    };
  }, [phase]);

  return (
    <>
      {/* Grain overlay and ripples only render before settled */}
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
          <div style={{
            opacity: ripplesExiting ? 0 : 1,
            transition: 'opacity 0.5s ease-out',
          }}>
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

      {/* Profile Photo — same element across all phases to preserve animation state */}
      <motion.div
        animate={profileControls}
        initial={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          x: '-50%',
          y: '-50%',
          zIndex: 42,
        }}
        style={{
          position: 'fixed',
          zIndex: 42,
          opacity: phase === 'settled' ? (profileVisible ? 1 : 0) : 1,
          transition: phase === 'settled' ? 'opacity 1s ease-in-out' : undefined,
          pointerEvents: phase === 'settled' && !profileVisible ? 'none' : 'auto',
        }}
      >
        <ProfilePicture
          profileBack={profileBack}
          profileFront={profileFront}
        />
      </motion.div>
    </>
  );
}
