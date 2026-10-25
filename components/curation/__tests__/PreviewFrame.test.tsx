import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PreviewFrame from '../PreviewFrame';

// #16's curator frame: the marker on its own toolbar, outside the visitor
// viewport, over a same-origin iframe of the draft's site.

const SRC = `/curation/preview/rev_${'a'.repeat(64)}/site`;

describe('PreviewFrame', () => {
    it('marks the preview outside the iframe, and frames the site it is given without sending a referrer', () => {
        render(<PreviewFrame src={SRC} />);
        const region = screen.getByRole('region', { name: 'Visitor preview' });
        const frame = screen.getByTitle('Visitor preview of the draft catalog');
        expect(frame.tagName).toBe('IFRAME');
        expect(frame).toHaveAttribute('src', SRC);
        expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
        const marker = screen.getByText('Preview · not public');
        expect(region).toContainElement(marker);
        expect(frame.contains(marker)).toBe(false);
    });

    it('takes a height, for a panel inside another page', () => {
        render(<PreviewFrame src={SRC} height="32rem" />);
        expect(screen.getByRole('region', { name: 'Visitor preview' })).toHaveStyle({ height: '32rem' });
    });
});
