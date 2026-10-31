'use client';

import { Component, type ReactNode } from 'react';

/**
 * Catches a failed lazy chunk (a dropped request, a page left open across a redeploy) and renders `fallback` in its
 * place, instead of letting the throw reach the route's error page or global-error. `onFailed` hears about it.
 */
export default class QuietBoundary extends Component<{ children: ReactNode; fallback?: ReactNode; onFailed?: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onFailed?.();
  }

  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
