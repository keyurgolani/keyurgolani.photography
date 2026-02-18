'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from './ThemeContext';

// Get auto-hide timeout from env, default to 3000ms (3 seconds)
const AUTO_HIDE_TIMEOUT = parseInt(
  process.env.NEXT_PUBLIC_UI_AUTO_HIDE_TIMEOUT || '3000',
  10
);

export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const [isVisible, setIsVisible] = useState(false); // Hidden by default
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastMousePos = useRef<{ x: number, y: number } | null>(null);

  const resetTimer = useCallback(() => {
    setIsVisible(true);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => setIsVisible(false), AUTO_HIDE_TIMEOUT);
  }, []);

  useEffect(() => {
    const handleActivity = () => {
      resetTimer();
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

    // Activity events to show the button (hidden by default, shows on interaction)
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('touchstart', handleActivity);
    window.addEventListener('click', handleActivity);
    window.addEventListener('keydown', handleActivity);
    window.addEventListener('scroll', handleActivity);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('touchstart', handleActivity);
      window.removeEventListener('click', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      window.removeEventListener('scroll', handleActivity);
    };
  }, [resetTimer]);

  const handleToggle = () => {
    toggleTheme();
    resetTimer(); // Reset timer on interaction with the button
  };
  
  return (
    <button
      onClick={handleToggle}
      aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
      className={`fixed top-6 left-6 z-[2000] p-3 rounded-full bg-white/80 dark:bg-black/60 backdrop-blur-xl border border-black/10 dark:border-white/20 shadow-[0_4px_20px_rgba(0,0,0,0.1)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.5)] transition-all duration-500 hover:scale-110 hover:shadow-[0_6px_25px_rgba(0,0,0,0.15)] dark:hover:shadow-[0_6px_25px_rgba(0,0,0,0.6)] group ${
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4 pointer-events-none'
      }`}
    >
      {theme === 'light' ? (
        <Moon size={20} strokeWidth={1.5} className="text-black/70 group-hover:text-black transition-colors" />
      ) : (
        <Sun size={20} strokeWidth={1.5} className="text-white/70 group-hover:text-white transition-colors" />
      )}
      <span className="absolute -bottom-10 left-1/2 -translate-x-1/2 px-2 py-1 bg-white dark:bg-black/80 text-black dark:text-white text-xs font-medium rounded-full opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap border border-black/10 dark:border-white/10 backdrop-blur-md shadow-lg">
        {theme === 'light' ? 'Dark' : 'Light'}
      </span>
    </button>
  );
}