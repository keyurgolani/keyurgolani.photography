'use client';

import React, { useState, useEffect, useRef } from 'react';

interface RevealingContentsProps {
  children: React.ReactNode;
  /** Called with the overlay's visibility on mount and whenever it changes. */
  onVisibleChange?: (visible: boolean) => void;
}

// Get auto-hide timeout from env, default to 3000ms (3 seconds)
const AUTO_HIDE_TIMEOUT = parseInt(
  process.env.NEXT_PUBLIC_UI_AUTO_HIDE_TIMEOUT || '3000',
  10
);

const RevealingContents: React.FC<RevealingContentsProps> = ({ children, onVisibleChange }) => {
  const [isVisible, setIsVisible] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastMousePos = useRef<{ x: number, y: number } | null>(null);

  useEffect(() => {
    const handleActivity = () => {
      setIsVisible(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setIsVisible(false), AUTO_HIDE_TIMEOUT);
    };

    const handleMouseMove = (e: MouseEvent) => {
      // On first move, just set the reference point and don't wake
      if (!lastMousePos.current) {
        lastMousePos.current = { x: e.clientX, y: e.clientY };
        return;
      }

      // Ignore minor movements (threshold: 100px)
      const dx = e.clientX - lastMousePos.current.x;
      const dy = e.clientY - lastMousePos.current.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance < 100) return; // Ignore small moves
      
      lastMousePos.current = { x: e.clientX, y: e.clientY };
      handleActivity();
    };

    // Listeners
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('touchstart', handleActivity);
    window.addEventListener('click', handleActivity);
    window.addEventListener('keydown', handleActivity);
    window.addEventListener('scroll', handleActivity);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('touchstart', handleActivity);
      window.removeEventListener('click', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      window.removeEventListener('scroll', handleActivity);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  useEffect(() => {
    onVisibleChange?.(isVisible);
  }, [isVisible, onVisibleChange]);

  // Keyboard focus inside shows the overlay at once, through has-[:focus-visible], and keeps it up.
  return (
    <div 
      className={`fixed inset-0 z-10 flex flex-col justify-between pointer-events-none transition-opacity duration-1000 ease-in-out has-[:focus-visible]:opacity-100 has-[:focus-visible]:transition-none ${isVisible ? 'opacity-100' : 'opacity-0'}`}
    >
      {/* The layer lets the pointer through to what's under it, like Home's settled portrait, so each piece of chrome takes it back with pointer-events-auto. */}
      <div className="w-full h-full flex flex-col justify-end">
          {children}
      </div>
    </div>
  );
};

export default RevealingContents;
