'use client';

import React, { useId } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import { usePrefersReducedMotion } from '../motion/usePrefersReducedMotion';
import styles from './HomeSequenceControls.module.css';

interface HomeSequenceControlsProps {
  index: number;
  count: number;
  /** From useHomePlayback. It alone picks the button's name, so holds and hidden tabs never change it. */
  wantsPlay: boolean;
  onPrev: () => void;
  onNext: () => void;
  onTogglePlayback: () => void;
  onPointerEnter?: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerLeave?: (event: React.PointerEvent<HTMLDivElement>) => void;
}

/** At least two digits, so the position reads 07 / 12 and 07 / 115. */
const pad = (value: number) => String(value).padStart(2, '0');

/**
 * Previous, the position, Next, and Pause or Play for Home's slideshow. They
 * sit in the chrome layer, never in the slide stack, and stay in the keyboard
 * order whether or not the chrome is showing.
 */
const HomeSequenceControls: React.FC<HomeSequenceControlsProps> = ({
  index,
  count,
  wantsPlay,
  onPrev,
  onNext,
  onTogglePlayback,
  onPointerEnter,
  onPointerLeave,
}) => {
  const reducedMotion = usePrefersReducedMotion();
  const hintId = useId();

  if (count < 2) return null;

  return (
    <div
      role="group"
      aria-label="Slideshow"
      className={styles.controls}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className={styles.row}>
        <button type="button" className={styles.button} aria-label="Previous photograph" onClick={onPrev}>
          <ChevronLeft size={24} aria-hidden="true" />
        </button>
        <span className={styles.position}>
          {pad(index + 1)} / {pad(count)}
        </span>
        <button type="button" className={styles.button} aria-label="Next photograph" onClick={onNext}>
          <ChevronRight size={24} aria-hidden="true" />
        </button>
        {/* aria-disabled, not disabled, keeps it in the keyboard order under reduced motion. */}
        <button
          type="button"
          className={`${styles.button} ${styles.playback}`}
          aria-label={wantsPlay ? 'Pause slideshow' : 'Play slideshow'}
          aria-disabled={reducedMotion ? 'true' : undefined}
          aria-describedby={reducedMotion ? hintId : undefined}
          onClick={reducedMotion ? undefined : onTogglePlayback}
        >
          {wantsPlay ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
          <span className={styles.label}>
            <span>{wantsPlay ? 'Pause' : 'Play'}</span>
          </span>
        </button>
      </div>
      {reducedMotion && (
        <span id={hintId} className={styles.hint}>
          Off with reduced motion
        </span>
      )}
    </div>
  );
};

export default HomeSequenceControls;
