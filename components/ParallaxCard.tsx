'use client';

import React, { useRef, useCallback, useEffect } from 'react';
import styles from './ParallaxCard.module.css';

interface ParallaxCardProps {
  className?: string;
  cardOffset: number;
  baseLayerOffset: number;
  layerOffsetMultiplier: number;
  /**
   * STAGE 1 PROTOTYPE. Follow a mouse over the card from the window instead of
   * the card's own events, for a card that takes no pointer: on Home the
   * chrome's layer (z 50) covers the loader once a mouse wakes it.
   */
  trackWindow?: boolean;
  children?: React.ReactNode | React.ReactNode[];
}

const ParallaxCard: React.FC<ParallaxCardProps> = ({
  className = '',
  cardOffset,
  baseLayerOffset,
  layerOffsetMultiplier,
  trackWindow = false,
  children,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const layerRefs = useRef<(HTMLDivElement | null)[]>([]);

  const animateCard = useCallback((event: { clientX: number; clientY: number }) => {
    const card = cardRef.current;
    if (!card) return;

    const elementBounds = card.getBoundingClientRect();
    const elementVCenter = elementBounds.top + elementBounds.height / 2;
    const elementHCenter = elementBounds.left + elementBounds.width / 2;
    
    // Normalize to -0.5 to 0.5 range
    const offsetX = (elementHCenter - event.clientX) / window.innerWidth;
    const offsetY = (elementVCenter - event.clientY) / window.innerHeight;

    const rotateX = -offsetY * cardOffset;
    const rotateY = offsetX * (cardOffset * 2);
    card.style.transform = `translateY(${-offsetX * cardOffset}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
    // STAGE 1 PROTOTYPE: how far the edge nearest the pointer lifts, for a shadow that follows the tilt.
    const liftX = Math.sin((-rotateY * Math.PI) / 180);
    const liftY = Math.sin((rotateX * Math.PI) / 180);
    card.style.setProperty('--tilt-x', liftX.toFixed(4));
    card.style.setProperty('--tilt-y', liftY.toFixed(4));
    card.style.setProperty('--tilt', Math.hypot(liftX, liftY).toFixed(4));

    layerRefs.current.forEach((layer) => {
      if (layer) {
        const offsetLayer = parseFloat(layer.dataset.offset || '0');
        layer.style.transform = `translateX(${offsetX * offsetLayer}px) translateY(${offsetY * offsetLayer}px)`;
      }
    });
  }, [cardOffset]);

  const resetTransform = useCallback(() => {
    const card = cardRef.current;
    if (card) {
      card.style.transform = '';
      for (const name of ['--tilt-x', '--tilt-y', '--tilt']) card.style.removeProperty(name);
    }
    layerRefs.current.forEach((layer) => {
      if (layer) layer.style.transform = '';
    });
  }, []);

  // The same hover tilt, from the window: inside the card's box it tilts, leaving it resets.
  useEffect(() => {
    if (!trackWindow) return;
    let inside = false;
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      const card = cardRef.current;
      if (!card) return;
      // The untransformed box and the layers' 10 px overhang, which the card's own events cover too.
      const box = (card.parentElement ?? card).getBoundingClientRect();
      const over = event.clientX >= box.left - 10 && event.clientX <= box.right + 10 && event.clientY >= box.top - 10 && event.clientY <= box.bottom + 10;
      if (over) {
        inside = true;
        animateCard(event);
      } else if (inside) {
        inside = false;
        resetTransform();
      }
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [trackWindow, animateCard, resetTransform]);

  // Update refs array size
  const childrenArray = React.Children.toArray(children);
  layerRefs.current = layerRefs.current.slice(0, childrenArray.length);

  return (
    <div
      ref={cardRef}
      className={`${styles.card} ${className}`}
      onMouseMove={trackWindow ? undefined : animateCard}
      onMouseLeave={trackWindow ? undefined : resetTransform}
    >
      {React.Children.map(children, (child, index) => {
        const offset = baseLayerOffset + index * layerOffsetMultiplier;
        return (
          <div
            key={index}
            ref={(el) => { layerRefs.current[index] = el; }}
            className={styles.layer}
            data-offset={offset}
          >
            {child}
          </div>
        );
      })}
    </div>
  );
};

export default ParallaxCard;
