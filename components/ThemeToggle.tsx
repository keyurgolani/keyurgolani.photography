'use client';

import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from './ThemeContext';

export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  
  return (
    <button
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
      className="fixed top-6 left-6 z-50 p-3 rounded-full bg-white/80 dark:bg-black/60 backdrop-blur-xl border border-black/10 dark:border-white/20 shadow-[0_4px_20px_rgba(0,0,0,0.1)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.5)] transition-all duration-300 hover:scale-110 hover:shadow-[0_6px_25px_rgba(0,0,0,0.15)] dark:hover:shadow-[0_6px_25px_rgba(0,0,0,0.6)] group"
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