import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RevealingContents from '../RevealingContents';

describe('RevealingContents', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports its visibility on mount, on activity, and when it hides again', () => {
    const onVisibleChange = vi.fn();
    render(
      <RevealingContents onVisibleChange={onVisibleChange}>
        <button type="button">Inside</button>
      </RevealingContents>
    );
    expect(onVisibleChange).toHaveBeenLastCalledWith(false);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown'));
    });
    expect(onVisibleChange).toHaveBeenLastCalledWith(true);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(onVisibleChange).toHaveBeenLastCalledWith(false);
  });

  it('shows itself at once, and stays up, while keyboard focus is inside', () => {
    render(
      <RevealingContents>
        <button type="button">Inside</button>
      </RevealingContents>
    );
    const overlay = screen.getByRole('button', { name: 'Inside' }).closest('.fixed');

    expect(overlay?.className).toContain('has-[:focus-visible]:opacity-100');
    expect(overlay?.className).toContain('has-[:focus-visible]:transition-none');
  });
});
