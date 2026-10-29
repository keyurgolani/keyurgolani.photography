import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TONE_SETTLE_MS, useCopyTone } from '../useCopyTone';

const tone = vi.hoisted(() => ({ next: 'dark' as 'dark' | 'light' | null, calls: 0, resolvers: [] as Array<(value: 'dark' | 'light' | null) => void>, held: false }));
vi.mock('../../badgePlace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../badgePlace')>();
  return {
    ...actual,
    copyTone: () => {
      tone.calls += 1;
      if (tone.held) return new Promise((resolve) => tone.resolvers.push(resolve));
      return Promise.resolve(tone.next);
    },
  };
});

function Slides({ shown, loaded }: { shown?: string; loaded: boolean }) {
  const carousel = useRef<HTMLDivElement>(null);
  useCopyTone(carousel, shown, loaded);
  return (
    <div ref={carousel}>
      {['a', 'b'].map((id) => (
        <div key={id} data-photo-id={id} aria-hidden={id !== shown}>
          <img alt="" src={`/${id}.webp`} />
        </div>
      ))}
    </div>
  );
}

const home = (shown: string | undefined, loaded: boolean, story = true) => (
  <main data-testid="home">
    {story && (
      <div data-chrome-region="story">
        <h1>Coastline, early</h1>
      </div>
    )}
    <Slides shown={shown} loaded={loaded} />
  </main>
);

describe('useCopyTone', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    tone.calls = 0;
    tone.held = false;
    tone.resolvers = [];
  });

  const withBoxes = () =>
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 40, top: 480, right: 600, bottom: 720, width: 560, height: 240, x: 40, y: 480, toJSON: () => ({}) });

  it("keeps its tone when the image can't be read now, and measures again once the image loads its new source (M5)", async () => {
    withBoxes();
    tone.next = 'dark';
    const view = render(home('a', true));
    const root = view.getByTestId('home');
    await act(async () => undefined);
    expect(root.getAttribute('data-copy-tone')).toBe('dark');
    // A rotation picks a larger candidate: mid-swap the image can't be read, and the tone stays.
    tone.next = null;
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await new Promise((resolve) => setTimeout(resolve, TONE_SETTLE_MS + 50));
    });
    expect(root.getAttribute('data-copy-tone')).toBe('dark');
    // The new source loads, over a light region now.
    tone.next = 'light';
    await act(async () => {
      view.container.querySelector('[data-photo-id="a"] img')!.dispatchEvent(new Event('load'));
    });
    expect(root.getAttribute('data-copy-tone')).toBe('light');
  });

  it('writes only the newest measure, however the samples resolve (L6)', async () => {
    withBoxes();
    tone.held = true;
    const view = render(home('a', true));
    const root = view.getByTestId('home');
    const image = view.container.querySelector('[data-photo-id="a"] img')!;
    await act(async () => {
      image.dispatchEvent(new Event('load'));
    });
    expect(tone.resolvers.length).toBe(2);
    await act(async () => {
      tone.resolvers[1]('dark');
      tone.resolvers[0]('light');
    });
    expect(root.getAttribute('data-copy-tone')).toBe('dark');
  });

  it("sets the tone on Home's root once the photograph on screen has loaded, again at each slide change, and clears it when Home goes", async () => {
    // jsdom lays nothing out; the copy needs a box to sample under.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 40, top: 480, right: 600, bottom: 720, width: 560, height: 240, x: 40, y: 480, toJSON: () => ({}) });
    tone.next = 'dark';
    const view = render(home('a', false));
    const root = view.getByTestId('home');
    expect(root.hasAttribute('data-copy-tone')).toBe(false);
    await act(async () => view.rerender(home('a', true)));
    expect(root.getAttribute('data-copy-tone')).toBe('dark');
    tone.next = 'light';
    await act(async () => view.rerender(home('b', true)));
    expect(root.getAttribute('data-copy-tone')).toBe('light');
    view.unmount();
    expect(root.hasAttribute('data-copy-tone')).toBe(false);
  });

  it("measures nothing with no copy on the page, so the theme keeps its own scrim", async () => {
    const view = render(home('a', true, false));
    await act(async () => undefined);
    expect(view.getByTestId('home').hasAttribute('data-copy-tone')).toBe(false);
    expect(tone.calls).toBe(0);
  });
});
