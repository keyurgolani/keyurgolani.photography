'use client';

import React, { useCallback, useEffect, useRef } from 'react';
import styles from './ParallaxCard.module.css';

interface ParallaxCardProps {
  className?: string;
  /** How far a mouse over the card turns and lifts it: 50 is v1.1.0's. */
  cardOffset: number;
  /** No tilt at all, as under reduced motion. Turning it on lets go of a tilt in progress. */
  still?: boolean;
  children?: React.ReactNode;
}

/** The tilt's custom properties, for a shadow that follows it. */
const TILT_PROPERTIES = ['--tilt-x', '--tilt-y', '--tilt'] as const;
/** The layer's overhang past the card, which a mouse over it counts as over the card, as v1.1.0's hover did. */
const OVERHANG_PX = 10;

/**
 * A card that turns toward a mouse over it, in perspective, and comes back
 * to rest when the mouse leaves: v1.1.0's hover tilt. It follows the mouse
 * from the window, so the card can take no pointer and sit under Home's
 * chrome, which keeps every click and tap. A touch or a pen never tilts it.
 *
 * It also sets how far the edge nearest the mouse lifts toward the viewer,
 * as the sine of each turn: `--tilt-x` (the right edge, negative for the
 * left), `--tilt-y` (the bottom edge, negative for the top), and `--tilt`,
 * their length, for a shadow that follows the tilt.
 */
const ParallaxCard: React.FC<ParallaxCardProps> = ({ className = '', cardOffset, still = false, children }) => {
  const cardRef = useRef<HTMLDivElement>(null);

  const animateCard = useCallback(
    (card: HTMLDivElement, event: PointerEvent) => {
      const elementBounds = card.getBoundingClientRect();
      const elementVCenter = elementBounds.top + elementBounds.height / 2;
      const elementHCenter = elementBounds.left + elementBounds.width / 2;

      // Normalize to -0.5 to 0.5 range
      const offsetX = (elementHCenter - event.clientX) / window.innerWidth;
      const offsetY = (elementVCenter - event.clientY) / window.innerHeight;

      const rotateX = -offsetY * cardOffset;
      const rotateY = offsetX * (cardOffset * 2);
      // The class's perspective stays first, so the turn reads as depth, and the transition runs between like lists.
      card.style.transform = `perspective(800px) translateY(${-offsetX * cardOffset}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
      const liftX = Math.sin((-rotateY * Math.PI) / 180);
      const liftY = Math.sin((rotateX * Math.PI) / 180);
      card.style.setProperty('--tilt-x', liftX.toFixed(4));
      card.style.setProperty('--tilt-y', liftY.toFixed(4));
      card.style.setProperty('--tilt', Math.hypot(liftX, liftY).toFixed(4));
    },
    [cardOffset],
  );

  const resetTransform = useCallback(() => {
    const card = cardRef.current;
    if (!card) return;
    card.style.transform = '';
    for (const name of TILT_PROPERTIES) card.style.removeProperty(name);
  }, []);

  useEffect(() => {
    if (still) {
      resetTransform();
      return;
    }
    let over = false;
    const onMove = (event: PointerEvent) => {
      const card = cardRef.current;
      if (!card || event.pointerType !== 'mouse') return;
      // The card's own box, as it lays out, and the layer's overhang. A hidden card has no box.
      const box = (card.parentElement ?? card).getBoundingClientRect();
      const inside =
        box.width > 0 &&
        event.clientX >= box.left - OVERHANG_PX &&
        event.clientX <= box.right + OVERHANG_PX &&
        event.clientY >= box.top - OVERHANG_PX &&
        event.clientY <= box.bottom + OVERHANG_PX;
      if (inside) {
        over = true;
        animateCard(card, event);
      } else if (over) {
        over = false;
        resetTransform();
      }
    };
    // The mouse leaving the window leaves the card too.
    const onLeave = () => {
      over = false;
      resetTransform();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, [still, animateCard, resetTransform]);

  return (
    <div ref={cardRef} className={`${styles.card} ${className}`}>
      <div className={styles.layer}>{children}</div>
    </div>
  );
};

export default ParallaxCard;
