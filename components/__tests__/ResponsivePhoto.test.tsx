import { fireEvent, render } from '@testing-library/react';
import { createRef, StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicAssetProjection } from '../../lib/identity/metadata';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../../lib/identity/variants';
import { mediaUrl } from '../../lib/media/url';
import ResponsivePhoto from '../ResponsivePhoto';
import { stopFetching } from '../stopFetching';
import { preloadsIn, serverHtml } from '@/test/helpers/serverHtml';

const REF = { photoId: 'ph_00000000-0000-4000-8000-000000000001', assetRevision: `sha256-${'b'.repeat(64)}`, profileId: 'p_0123456789abcdef' };
const LQIP = 'data:image/webp;base64,UklGRhIAAABXRUJQVlA4';

/** An asset `width` x `height` whose variants are as wide as the profile allows, never enlarged. */
function asset(width: number, height: number, lqip: string | null = LQIP): Pick<PublicAssetProjection, 'width' | 'height' | 'variants'> & { lqip?: string } {
  const variants = {} as PublicAssetProjection['variants'];
  for (const variant of VARIANT_WIDTHS) {
    const target = Math.min(Number(variant.slice(1)), width);
    variants[variant] = {} as PublicAssetProjection['variants'][typeof variant];
    for (const format of VARIANT_FORMATS) {
      variants[variant][format] = { url: mediaUrl(REF, variant, format), width: target, height: Math.round((target * height) / width), bytes: 1_000 };
    }
  }
  return { width, height, variants, ...(lqip === null ? {} : { lqip }) };
}

const url = (variant: string, format: string) => `/media/${REF.photoId}/${REF.assetRevision}/${REF.profileId}/${variant}.${format}`;

describe('ResponsivePhoto', () => {
  it('renders AVIF, then WebP, sources and an image at w1200.webp with its dimensions and the LQIP behind it', () => {
    const { container } = render(
      <ResponsivePhoto asset={asset(3000, 2000)} alt="Fog over the ridge" sizes="(min-width: 800px) 50vw, 100vw" loading="lazy" fetchPriority="high" />,
    );
    const picture = container.querySelector('picture');
    expect(picture).not.toBeNull();
    const sources = [...container.querySelectorAll('source')];
    expect(sources.map((source) => source.getAttribute('type'))).toEqual(['image/avif', 'image/webp']);
    for (const [index, format] of (['avif', 'webp'] as const).entries()) {
      expect(sources[index].getAttribute('srcset')).toBe(
        `${url('w400', format)} 400w, ${url('w800', format)} 800w, ${url('w1200', format)} 1200w, ${url('w1920', format)} 1920w`,
      );
      expect(sources[index].getAttribute('sizes')).toBe('(min-width: 800px) 50vw, 100vw');
    }
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.parentElement).toBe(picture);
    expect(img.getAttribute('src')).toBe(url('w1200', 'webp'));
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['3000', '2000']);
    expect(img.getAttribute('alt')).toBe('Fog over the ridge');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('fetchpriority')).toBe('high');
    expect(img.style.backgroundImage).toBe(`url("${LQIP}")`);
    expect(img.style.backgroundSize).toBe('cover');
    // Centered, unless the page crops the photo elsewhere and says so in --photo-lqip-position.
    expect(img.style.backgroundPosition).toBe('var(--photo-lqip-position, center)');
  });

  it('lists each width once when a small photo makes several variants the same size', () => {
    const { container } = render(<ResponsivePhoto asset={asset(900, 600)} alt="A small print" sizes="100vw" />);
    const [avif, webp] = [...container.querySelectorAll('source')];
    expect(avif.getAttribute('srcset')).toBe(`${url('w400', 'avif')} 400w, ${url('w800', 'avif')} 800w, ${url('w1200', 'avif')} 900w`);
    expect(webp.getAttribute('srcset')).toBe(`${url('w400', 'webp')} 400w, ${url('w800', 'webp')} 800w, ${url('w1200', 'webp')} 900w`);
    const tiny = render(<ResponsivePhoto asset={asset(300, 200)} alt="A thumbnail-sized original" sizes="100vw" />).container;
    expect(tiny.querySelector('source')?.getAttribute('srcset')).toBe(`${url('w400', 'avif')} 300w`);
  });

  it('leaves out the background without an LQIP, and loads lazily unless told otherwise', () => {
    const { container } = render(<ResponsivePhoto asset={asset(3000, 2000, null)} alt="No placeholder" sizes="50vw" />);
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('style')).toBeNull();
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.hasAttribute('fetchpriority')).toBe(false);
  });

  it('requires sizes, so no use falls back to the full viewport', () => {
    // @ts-expect-error sizes is required.
    const element = <ResponsivePhoto asset={asset(3000, 2000)} alt="No sizes" />;
    expect(element.props).not.toHaveProperty('sizes');
  });

  it('forwards its ref to the image, and its error handler', () => {
    const ref = createRef<HTMLImageElement>();
    const onError = vi.fn();
    const { container } = render(<ResponsivePhoto ref={ref} asset={asset(3000, 2000)} alt="Ref target" sizes="100vw" onError={onError} className="gallery-photo" />);
    const img = container.querySelector('img') as HTMLImageElement;
    expect(ref.current).toBe(img);
    expect(img.className).toBe('gallery-photo');
    fireEvent.error(img);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('takes an empty alt for a decorative photo', () => {
    const { container } = render(<ResponsivePhoto asset={asset(3000, 2000)} alt="" sizes="100vw" />);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
  });

  it('requires alt', () => {
    // @ts-expect-error alt is required, even when it is empty.
    const element = <ResponsivePhoto asset={asset(3000, 2000)} sizes="100vw" />;
    expect(element.props).not.toHaveProperty('alt');
  });

  describe('the preload (#6)', () => {
    const headPreloads = () => [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="image"]')];

    it('puts one typed AVIF preload in the server HTML with the srcset and sizes the <picture> has', () => {
      const html = serverHtml(<ResponsivePhoto asset={asset(3000, 2000)} alt="Lead" sizes="(min-width: 48rem) 80vw, 100vw" loading="eager" preload />);
      const host = document.createElement('div');
      host.innerHTML = html;
      const avif = host.querySelector('source[type="image/avif"]')!;
      const links = preloadsIn(html);
      expect(links).toHaveLength(1);
      const [link] = links;
      expect(link.getAttribute('type')).toBe('image/avif');
      expect(link.getAttribute('imagesrcset')).toBe(avif.getAttribute('srcset'));
      expect(link.getAttribute('imagesizes')).toBe(avif.getAttribute('sizes'));
      expect(link.getAttribute('fetchpriority')).toBe('high');
      // The srcset decides; a bare href would fetch one file at every viewport.
      expect(link.hasAttribute('href')).toBe(false);
    });

    it('adds no preload unless asked, and one for the same photograph and sizes rendered twice', () => {
      expect(preloadsIn(serverHtml(<ResponsivePhoto asset={asset(3000, 2000)} alt="Not lead" sizes="100vw" />))).toHaveLength(0);
      const twice = serverHtml(
        <>
          <ResponsivePhoto asset={asset(3000, 2000)} alt="Lead" sizes="100vw" preload />
          <ResponsivePhoto asset={asset(3000, 2000)} alt="Lead again" sizes="100vw" preload />
        </>,
      );
      expect(preloadsIn(twice)).toHaveLength(1);
    });

    it('adds nothing to the head in a client render, so no link keeps a passed photograph downloading', () => {
      const before = headPreloads().length;
      const { unmount } = render(<ResponsivePhoto asset={asset(3000, 2000)} alt="Client lead" sizes="100vw" loading="eager" preload />);
      expect(headPreloads()).toHaveLength(before);
      unmount();
      expect(headPreloads()).toHaveLength(before);
    });
  });

  describe('a photograph that leaves before it finished (#6)', () => {
    afterEach(() => vi.restoreAllMocks());

    const attributes = (picture: Element) =>
      [...picture.querySelectorAll('source, img')].map((element) => [element.getAttribute('srcset'), element.getAttribute('src')]);

    it('stops fetching once it leaves the page', () => {
      vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false);
      const { container, unmount } = render(<ResponsivePhoto asset={asset(3000, 2000)} alt="Passed by" sizes="100vw" />);
      const picture = container.querySelector('picture')!;
      unmount();
      expect(attributes(picture)).toEqual([
        [null, null],
        [null, null],
        [null, null],
      ]);
    });

    it('leaves a finished image alone, and a Strict Mode rehearsal, which keeps it in the page', () => {
      vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false);
      const strict = render(
        <StrictMode>
          <ResponsivePhoto asset={asset(3000, 2000)} alt="Rehearsed" sizes="100vw" />
        </StrictMode>,
      );
      expect(strict.container.querySelector('img')?.getAttribute('src')).toBe(url('w1200', 'webp'));
      expect(strict.container.querySelector('source')?.getAttribute('srcset')).not.toBeNull();
      vi.restoreAllMocks();
      vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
      const { container, unmount } = render(<ResponsivePhoto asset={asset(3000, 2000)} alt="Shown" sizes="100vw" />);
      const picture = container.querySelector('picture')!;
      unmount();
      expect(picture.querySelector('img')?.getAttribute('src')).toBe(url('w1200', 'webp'));
    });

    it('stopFetching clears only its own <picture>', () => {
      document.body.innerHTML = '<picture><source srcset="a 1w"><img src="b" srcset="c 1w"></picture><picture><source srcset="d 1w"><img src="e"></picture>';
      const [first, second] = [...document.querySelectorAll('img')];
      stopFetching(first);
      expect(attributes(first.parentElement!)).toEqual([
        [null, null],
        [null, null],
      ]);
      expect(second.getAttribute('src')).toBe('e');
      expect(second.previousElementSibling?.getAttribute('srcset')).toBe('d 1w');
      document.body.innerHTML = '';
    });
  });
});
