'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from './ThemeContext';

const INACTIVITY_TIMEOUT = 3 * 60 * 1000; // 3 minutes

export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const [isVisible, setIsVisible] = useState(true);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const resetTimer = useCallback(() => {
    setIsVisible(true);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(() => setIsVisible(false), INACTIVITY_TIMEOUT);
  }, []);

  useEffect(() => {
    // Start the timer on mount
    resetTimer();

    // Activity events to show the button
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
    
    events.forEach(event => {
      window.addEventListener(event, resetTimer, { passive: true });
    });

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      events.forEach(event => {
        window.removeEventListener(event, resetTimer);
      });
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
      className={`fixed top-6 left-6 z-50 p-3 rounded-full bg-white/80 dark:bg-black/60 backdrop-blur-xl border border-black/10 dark:border-white/20 shadow-[0_4px_20px_rgba(0,0,0,0.1)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.5)] transition-all duration-500 hover:scale-110 hover:shadow-[0_6px_25px_rgba(0,0,0,0.15)] dark:hover:shadow-[0_6px_25px_rgba(0,0,0,0.6)] group ${
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