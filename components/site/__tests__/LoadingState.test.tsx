import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import LoadingState from '../LoadingState';

describe('LoadingState', () => {
  it('is a status region labelled Loading', () => {
    render(<LoadingState />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
  });

  it('draws no spinner, shimmer, or pulse', () => {
    const { container } = render(<LoadingState />);
    expect(container.querySelector('svg')).toBeNull();
    const animated = Array.from(container.querySelectorAll('*')).filter((element) =>
      Array.from(element.classList).some((name) => name.startsWith('animate-')),
    );
    expect(animated).toEqual([]);
  });
});
