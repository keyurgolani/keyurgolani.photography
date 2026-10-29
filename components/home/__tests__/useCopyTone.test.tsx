import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCopyTone } from '../useCopyTone';

const tone = vi.hoisted(() => ({ next: 'dark' as 'dark' | 'light', calls: 0 }));
vi.mock('../../badgePlace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../badgePlace')>();
  return {
    ...actual,
    copyTone: async () => {
      tone.calls += 1;
      return tone.next;
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
