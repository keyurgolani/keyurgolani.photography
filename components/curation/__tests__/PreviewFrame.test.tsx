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

    // 16-3: the Publish screen's panel names the region itself, keeps the frame out of the Tab order, and says "Live" once live.
    it('drops its own region label when embedded, leaves the Tab order when asked, and takes the marker and title it is given', () => {
        render(<PreviewFrame src={SRC} embedded focusable={false} marker="Live, revision 19" title="The live site, revision 19" />);
        expect(screen.queryByRole('region', { name: 'Visitor preview' })).toBeNull();
        const frame = screen.getByTitle('The live site, revision 19');
        expect(frame).toHaveAttribute('inert');
        // The inert iframe's title isn't read, so the picture carries it.
        expect(screen.getByRole('img', { name: 'The live site, revision 19' })).toContainElement(frame);
        expect(screen.getByText('Live, revision 19')).toBeInTheDocument();
        expect(screen.queryByText('Preview · not public')).toBeNull();
    });

    it('stays in the Tab order by default', () => {
        render(<PreviewFrame src={SRC} />);
        expect(screen.getByTitle('Visitor preview of the draft catalog')).not.toHaveAttribute('inert');
    });
});
