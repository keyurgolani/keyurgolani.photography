import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DISMISSED_LABEL_STYLE, useDismissibleLabel } from '../useDismissibleLabel';

function Control() {
    const { dismissed, handlers } = useDismissibleLabel();
    return (
        <button type="button" {...handlers}>
            Control
            <span data-testid="label" style={dismissed ? DISMISSED_LABEL_STYLE : undefined}>
                Label
            </span>
        </button>
    );
}

const pressEscape = () =>
    act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

describe('useDismissibleLabel', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('Escape hides a label shown on hover until the pointer leaves', () => {
        render(<Control />);
        const control = screen.getByRole('button', { name: /Control/ });
        const label = screen.getByTestId('label');

        fireEvent.pointerEnter(control);
        expect(label).not.toHaveStyle({ opacity: '0' });
        pressEscape();
        expect(label).toHaveStyle({ opacity: '0', pointerEvents: 'none' });

        fireEvent.pointerLeave(control);
        expect(label.style.opacity).toBe('');
    });

    it('Escape hides a label shown on focus until focus moves', () => {
        render(<Control />);
        const control = screen.getByRole('button', { name: /Control/ });
        const label = screen.getByTestId('label');

        act(() => control.focus());
        pressEscape();
        expect(label).toHaveStyle({ opacity: '0' });

        act(() => control.blur());
        expect(label.style.opacity).toBe('');
    });

    it('ignores other keys, and Escape while nothing shows the label', () => {
        render(<Control />);
        const control = screen.getByRole('button', { name: /Control/ });
        const label = screen.getByTestId('label');

        pressEscape();
        fireEvent.pointerEnter(control);
        expect(label.style.opacity).toBe('');
        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        expect(label.style.opacity).toBe('');
    });

    it('listens for Escape only while the label is shown', () => {
        const add = vi.spyOn(document, 'addEventListener');
        const remove = vi.spyOn(document, 'removeEventListener');
        const keydown = (spy: typeof add) => spy.mock.calls.filter(([type]) => type === 'keydown').length;
        const { unmount } = render(<Control />);
        const control = screen.getByRole('button', { name: /Control/ });

        expect(keydown(add)).toBe(0);
        fireEvent.pointerEnter(control);
        expect(keydown(add)).toBe(1);
        fireEvent.pointerLeave(control);
        expect(keydown(remove)).toBe(1);

        fireEvent.pointerEnter(control);
        unmount();
        expect(keydown(remove)).toBe(keydown(add));
    });
});
