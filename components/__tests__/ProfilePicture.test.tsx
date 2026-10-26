import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '@/lib/identity/variants';
import type { AboutPortraitView } from '@/lib/siteConfig/portraitVariants';
import ProfilePicture, { PROFILE_PICTURE_SIZES } from '../ProfilePicture';

const TOKEN = 'a'.repeat(32);

const PORTRAIT: AboutPortraitView = {
  asset: {
    width: 1600,
    height: 2000,
    variants: Object.fromEntries(
      VARIANT_WIDTHS.map((width) => [
        width,
        Object.fromEntries(VARIANT_FORMATS.map((format) => [format, { url: `/about/portrait/${TOKEN}/${width}.${format}`, width: Number(width.slice(1)) }])),
      ]),
    ) as AboutPortraitView['asset']['variants'],
  },
  alt: 'A stand-in portrait',
  focalPoint: { x: 40, y: 25 },
};

/** jsdom has no PointerEvent, so this gives a MouseEvent the pointer's type, as the card reads it from the window. */
function pointerMove(init: { clientX: number; clientY: number; pointerType: string }) {
  const event = new MouseEvent('pointermove', { clientX: init.clientX, clientY: init.clientY });
  Object.defineProperty(event, 'pointerType', { value: init.pointerType });
  act(() => {
    window.dispatchEvent(event);
  });
}

function renderPicture(props: Partial<React.ComponentProps<typeof ProfilePicture>> = {}) {
  // Every box: 320 px square with its center at (500, 400), in a 1000 x 800 window.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 340, top: 240, width: 320, height: 320, right: 660, bottom: 560, x: 340, y: 240, toJSON: () => ({}) });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  const view = render(<ProfilePicture portrait={PORTRAIT} {...props} />);
  const image = view.getByRole('img', { name: PORTRAIT.alt });
  const card = view.container.querySelector<HTMLElement>('[class*="card"]')!;
  return { ...view, image, card };
}

describe('ProfilePicture', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows About's one portrait, with its alt, focal point, and the small sizes the loader and the badge need", () => {
    const { image, container } = renderPicture();
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(image).toHaveAttribute('src', `/about/portrait/${TOKEN}/w1200.webp`);
    for (const source of container.querySelectorAll('source')) expect(source).toHaveAttribute('sizes', PROFILE_PICTURE_SIZES);
    expect(image).toHaveAttribute('loading', 'eager');
    expect(container.firstElementChild).toHaveStyle({ '--profile-focus': '40% 25%' });
  });

  it("tilts toward a mouse over it in perspective, with v1.1.0's card numbers, sets how far each edge lifts, and comes back to rest when it leaves", () => {
    const { card } = renderPicture();
    // The bottom-right corner: offsets of -0.16 and -0.2 of the window.
    pointerMove({ clientX: 660, clientY: 560, pointerType: 'mouse' });
    expect(card.style.transform).toBe('perspective(800px) translateY(8px) rotateX(10deg) rotateY(-16deg)');
    expect(Number(card.style.getPropertyValue('--tilt-x'))).toBeCloseTo(Math.sin((16 * Math.PI) / 180), 3);
    expect(Number(card.style.getPropertyValue('--tilt-y'))).toBeCloseTo(Math.sin((10 * Math.PI) / 180), 3);
    expect(Number(card.style.getPropertyValue('--tilt'))).toBeCloseTo(Math.hypot(Math.sin((16 * Math.PI) / 180), Math.sin((10 * Math.PI) / 180)), 3);

    // The layer's 10 px overhang still counts as over the card.
    pointerMove({ clientX: 670, clientY: 570, pointerType: 'mouse' });
    expect(card.style.transform).toContain('perspective(800px)');
    expect(card.style.transform).not.toBe('');

    pointerMove({ clientX: 671, clientY: 570, pointerType: 'mouse' });
    expect(card.style.transform).toBe('');
    for (const name of ['--tilt-x', '--tilt-y', '--tilt']) expect(card.style.getPropertyValue(name)).toBe('');

    pointerMove({ clientX: 660, clientY: 560, pointerType: 'mouse' });
    act(() => {
      document.documentElement.dispatchEvent(new MouseEvent('pointerleave'));
    });
    expect(card.style.transform).toBe('');
  });

  it('takes no pointer itself: the tilt follows the mouse from the window, and stops listening once gone', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { card, unmount } = renderPicture();
    expect(card.getAttributeNames().filter((name) => name.startsWith('on'))).toEqual([]);
    const listener = add.mock.calls.find(([type]) => type === 'pointermove')?.[1];
    expect(listener).toBeDefined();
    unmount();
    expect(remove).toHaveBeenCalledWith('pointermove', listener);
  });

  it('never tilts for a touch or a pen, so a tap leaves nothing turned', () => {
    const { card } = renderPicture();
    for (const pointerType of ['touch', 'pen']) {
      pointerMove({ clientX: 660, clientY: 560, pointerType });
      expect(card.style.transform).toBe('');
    }
  });

  it('holds still under reduced motion, and lets go of a tilt in progress when it turns on', () => {
    const view = renderPicture();
    pointerMove({ clientX: 660, clientY: 560, pointerType: 'mouse' });
    expect(view.card.style.transform).not.toBe('');
    view.rerender(<ProfilePicture portrait={PORTRAIT} still />);
    expect(view.card.style.transform).toBe('');
    expect(view.card.style.getPropertyValue('--tilt')).toBe('');
    pointerMove({ clientX: 660, clientY: 560, pointerType: 'mouse' });
    expect(view.card.style.transform).toBe('');
  });

  it('reports an image that fails to load, as an error and as one the server HTML already failed', () => {
    const onUnusable = vi.fn();
    const { image } = renderPicture({ onUnusable });
    fireEvent.error(image);
    expect(onUnusable).toHaveBeenCalledTimes(1);

    const failed = vi.fn();
    const complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    const naturalWidth = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(0);
    render(<ProfilePicture portrait={PORTRAIT} onUnusable={failed} />);
    expect(failed).toHaveBeenCalled();
    complete.mockRestore();
    naturalWidth.mockRestore();
  });
});
