'use client';

import React, { useRef, useCallback } from 'react';
import styles from './ParallaxCard.module.css';

interface ParallaxCardProps {
  className?: string;
  cardOffset: number;
  baseLayerOffset: number;
  layerOffsetMultiplier: number;
  children?: React.ReactNode | React.ReactNode[];
}

const ParallaxCard: React.FC<ParallaxCardProps> = ({
  className = '',
  cardOffset,
  baseLayerOffset,
  layerOffsetMultiplier,
  children,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const layerRefs = useRef<(HTMLDivElement | null)[]>([]);

  const animateCard = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const card = cardRef.current;
    if (!card) return;

    const elementBounds = card.getBoundingClientRect();
    const elementVCenter = elementBounds.top + elementBounds.height / 2;
    const elementHCenter = elementBounds.left + elementBounds.width / 2;
    
    // Normalize to -0.5 to 0.5 range
    const offsetX = (elementHCenter - event.clientX) / window.innerWidth;
    const offsetY = (elementVCenter - event.clientY) / window.innerHeight;

    card.style.transform = `translateY(${-offsetX * cardOffset}px) rotateX(${-offsetY * cardOffset}deg) rotateY(${offsetX * (cardOffset * 2)}deg)`;

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
    }
    layerRefs.current.forEach((layer) => {
      if (layer) layer.style.transform = '';
    });
  }, []);

  // Update refs array size
  const childrenArray = React.Children.toArray(children);
  layerRefs.current = layerRefs.current.slice(0, childrenArray.length);

  return (
    <div
      ref={cardRef}
      className={`${styles.card} ${className}`}
      onMouseMove={animateCard}
      onMouseLeave={resetTransform}
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
