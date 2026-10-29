import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./utils/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  // Black is today's site (themes, owner ruling 2026-10-28), so the legacy dark: variants apply there too.
  darkMode: ['variant', ['&:is([data-theme="dark"] *)', '&:is([data-theme="black"] *)']],
  // Wraps every hover: and group-hover: utility in (hover: hover) and (pointer: fine), so a tap never leaves hover styles behind.
  future: { hoverOnlyWhenSupported: true },
  theme: {
    extend: {
      screens: {
        '3xl': '1920px',
        '4xl': '2560px',
      },
      colors: {
        background: "var(--background-color)",
        primary: "var(--primary-color)",
        secondary: "var(--secondary-color)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "sans-serif"],
        serif: ["var(--font-serif)", "serif"],
        primary: ["var(--font-serif)", "serif"],
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        fadeInLeft: {
            '0%': { opacity: '0', transform: 'translateX(-20px)' },
            '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        fadeInRight: {
            '0%': { opacity: '0', transform: 'translateX(20px)' },
            '100%': { opacity: '1', transform: 'translateX(0)' },
        }
      },
      animation: {
        'fade-in': 'fadeIn 1s ease-in-out',
        'fade-in-up': 'fadeInUp 0.8s ease-out',
        'fade-in-left': 'fadeInLeft 0.8s ease-out',
        'fade-in-right': 'fadeInRight 0.8s ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
