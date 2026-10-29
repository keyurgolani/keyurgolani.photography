'use client';

import { useEffect } from 'react';
import '../styles/theme-menu-popover.css';

/** Renders nothing: importing it brings the popover's styles, and it reports once they're in the document. */
export default function ThemeMenuPopoverStyles({ onReady }: { onReady: () => void }) {
  useEffect(() => onReady(), [onReady]);
  return null;
}
