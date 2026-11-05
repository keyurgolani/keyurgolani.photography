import { fireEvent, render, screen } from '@testing-library/react';
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

    // A9 (#182): the full preview's toolbar.
    it('has Fit, Desktop and Mobile presets as pressed buttons, the short hash, and Back to Publish', () => {
        render(<PreviewFrame src={SRC} draftHash="1a2b3c4d" presets backHref="/curation/publish" />);
        const group = screen.getByRole('group', { name: 'Frame size' });
        const fit = screen.getByRole('button', { name: 'Fit the window' });
        const desktop = screen.getByRole('button', { name: 'Desktop, 1440 by 900' });
        const mobile = screen.getByRole('button', { name: 'Mobile, 390 by 844' });
        expect(group).toContainElement(fit);
        for (const button of [fit, desktop, mobile]) expect(button).toHaveAttribute('type', 'button');
        expect(fit).toHaveAttribute('aria-pressed', 'true');
        expect(desktop).toHaveAttribute('aria-pressed', 'false');
        expect(screen.getByText('Draft 1a2b3c4d')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Back to Publish' })).toHaveAttribute('href', '/curation/publish');
        const frame = screen.getByTitle('Visitor preview of the draft catalog');
        fireEvent.click(desktop);
        expect(desktop).toHaveAttribute('aria-pressed', 'true');
        expect(fit).toHaveAttribute('aria-pressed', 'false');
        // The same iframe, resized: a preset never reloads the page inside.
        expect(screen.getByTitle('Visitor preview of the draft catalog')).toBe(frame);
        expect(frame).toHaveStyle({ width: '1440px', height: '900px' });
        fireEvent.click(mobile);
        expect(frame).toHaveStyle({ width: '390px', height: '844px' });
        fireEvent.click(fit);
        expect(frame.style.width).toBe('');
    });

    it('names each preset the same once the stylesheet lays it out (A9 CI fix)', () => {
        render(<PreviewFrame src={SRC} presets />);
        // jsdom applies no CSS module. In a browser, the visually hidden words are absolutely placed, which makes them a
        // block, and a block's text joins a name with a space around it: "Desktop , 1440 by 900", which the e2e walk missed.
        for (const part of screen.getByRole('group', { name: 'Frame size' }).querySelectorAll<HTMLElement>('button *')) part.style.display = 'block';
        expect(screen.getByRole('button', { name: 'Desktop, 1440 by 900' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Mobile, 390 by 844' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Fit the window' })).toBeInTheDocument();
    });

    it('keeps the embedded panel to its marker, with no presets', () => {
        render(<PreviewFrame src={SRC} embedded focusable={false} />);
        expect(screen.queryByRole('group', { name: 'Frame size' })).toBeNull();
        expect(screen.queryByRole('link', { name: 'Back to Publish' })).toBeNull();
    });
});
