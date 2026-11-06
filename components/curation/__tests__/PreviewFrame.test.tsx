import fs from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';
import PreviewFrame from '../PreviewFrame';

// #16's curator frame: the marker on its own toolbar, outside the visitor
// viewport, over a same-origin iframe of the draft's site.

const SRC = `/curation/preview/rev_${'a'.repeat(64)}/site`;

/** The frame's own stylesheet, which jsdom never applies (read from the repo root, as curatorThemes.test.ts does): each top-level rule's declarations, by selector. */
const STYLES = (() => {
    const rules = new Map<string, Record<string, string>>();
    postcss.parse(fs.readFileSync(path.join(process.cwd(), 'components/curation/PreviewFrame.module.css'), 'utf8')).each((node) => {
        if (node.type !== 'rule') return;
        const decls: Record<string, string> = {};
        (node as Rule).walkDecls((decl) => void (decls[decl.prop] = decl.value.replace(/\s+/g, ' ')));
        rules.set((node as Rule).selector, { ...rules.get((node as Rule).selector), ...decls });
    });
    return rules;
})();

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
        const desktop = screen.getByRole('button', { name: 'Desktop 1440 × 900' });
        const mobile = screen.getByRole('button', { name: 'Mobile 390 × 844' });
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

    /** The name the page computes for `button`, through the same matcher getByRole uses. */
    const nameOf = (button: HTMLElement): string => {
        let name = '';
        screen.getAllByRole('button', {
            name: (computed, element) => {
                if (element === button) name = computed;
                return element === button;
            },
        });
        return name;
    };
    const visibleText = (element: HTMLElement) => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    /** In a browser each part of an inline-flex button is a flex item, which is a block; jsdom applies no CSS module. */
    const asLaidOut = () => {
        for (const part of screen.getByRole('group', { name: 'Frame size' }).querySelectorAll<HTMLElement>('button *')) part.style.display = 'block';
    };

    it('names each preset the same once the stylesheet lays it out (A9 CI fix)', () => {
        render(<PreviewFrame src={SRC} presets />);
        // A block's text joins a name with a space around it, so a visually hidden ", 1440 by 900" read "Desktop , 1440 by 900".
        asLaidOut();
        expect(screen.getByRole('button', { name: 'Desktop 1440 × 900' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Mobile 390 × 844' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Fit the window' })).toBeInTheDocument();
    });

    it('names each preset with its visible text, exactly, laid out or not (WCAG 2.5.3, axe label-content-name-mismatch; A9 CI fix)', () => {
        render(<PreviewFrame src={SRC} presets />);
        const buttons = within(screen.getByRole('group', { name: 'Frame size' })).getAllByRole('button');
        expect(buttons.map(visibleText)).toEqual(['Fit the window', 'Desktop 1440 × 900', 'Mobile 390 × 844']);
        for (const button of buttons) expect(nameOf(button), visibleText(button)).toBe(visibleText(button));
        asLaidOut();
        for (const button of buttons) expect(nameOf(button), visibleText(button)).toBe(visibleText(button));
    });

    it("keeps the Publish panel's markup as it was before A9: a <p> toolbar holding the marker alone, then the picture (A9 CI fix)", () => {
        // Dark parity matches elements by tag and position, so a <div> toolbar moved every path under the panel's frame.
        const { container } = render(<PreviewFrame src={SRC} embedded focusable={false} marker="Draft" />);
        const frame = container.firstElementChild as HTMLElement;
        expect([...frame.children].map((child) => child.tagName)).toEqual(['P', 'DIV']);
        expect([...(frame.children[0] as HTMLElement).children].map((child) => child.tagName)).toEqual(['SPAN']);
        expect(frame.children[1]).toHaveAttribute('role', 'img');
    });

    it('keeps the full toolbar a <p> too, holding only phrasing content, so nothing in it breaks the paragraph (A9 CI fix)', () => {
        const { container } = render(<PreviewFrame src={SRC} draftHash="1a2b3c4d" presets backHref="/curation/publish" />);
        const toolbar = (container.firstElementChild as HTMLElement).children[0] as HTMLElement;
        expect(toolbar.tagName).toBe('P');
        expect(toolbar.querySelectorAll('div, p, section, ul, ol')).toHaveLength(0);
        expect(within(toolbar).getByRole('group', { name: 'Frame size' }).tagName).toBe('SPAN');
    });

    it("gives the full toolbar's controls room for their focus ring above and below, and the Publish panel's toolbar none (A9 CI fix)", () => {
        // The toolbar opens the page and is as tall as its 44 px controls, so a ring drawn outside a preset went above the
        // viewport's top edge (contract rule 4). The room is the ring's own: its width plus its offset.
        expect(STYLES.get(".frame:not([data-embedded='true']) .toolbar")).toMatchObject({ 'padding-block': 'calc(var(--focus-ring-width) + var(--focus-ring-offset))' });
        // The panel's toolbar keeps next's styles, which Dark parity compares exactly.
        expect(STYLES.get('.toolbar')).toMatchObject({ padding: '0 var(--site-gutter)', 'min-height': '44px' });
        expect(STYLES.get('.toolbar')).not.toHaveProperty('padding-block');
        expect(STYLES.get(".frame[data-embedded='true'] .toolbar")).toEqual({ padding: '0 0.875rem' });
    });

    it('keeps the embedded panel to its marker, with no presets', () => {
        render(<PreviewFrame src={SRC} embedded focusable={false} />);
        expect(screen.queryByRole('group', { name: 'Frame size' })).toBeNull();
        expect(screen.queryByRole('link', { name: 'Back to Publish' })).toBeNull();
    });
});
