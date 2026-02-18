'use client';

import React, { useState, useEffect, useRef } from 'react';

interface RevealingContentsProps {
  children: React.ReactNode;
}

// Get auto-hide timeout from env, default to 3000ms (3 seconds)
const AUTO_HIDE_TIMEOUT = parseInt(
  process.env.NEXT_PUBLIC_UI_AUTO_HIDE_TIMEOUT || '3000',
  10
);

const RevealingContents: React.FC<RevealingContentsProps> = ({ children }) => {
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

  return (
    <div 
      className={`fixed inset-0 z-10 flex flex-col justify-between pointer-events-none transition-opacity duration-1000 ease-in-out ${isVisible ? 'opacity-100' : 'opacity-0'}`}
    >
      {/* 
         We use pointer-events-auto on the children so they are clickable 
         when visible, but the container itself lets clicks pass through to the background if needed 
         (though here background is just visual). 
         
         The actual content is rendered here. When opacity is 0, it's invisible.
      */}
      <div className="w-full h-full pointer-events-auto flex flex-col justify-end">
          {children}
      </div>
    </div>
  );
};

export default RevealingContents;
