import { fireEvent, render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PublicAssetProjection } from '../../lib/identity/metadata';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../../lib/identity/variants';
import { mediaUrl } from '../../lib/media/url';
import ResponsivePhoto from '../ResponsivePhoto';

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
  });

  it('lists each width once when a small photo makes several variants the same size', () => {
    const { container } = render(<ResponsivePhoto asset={asset(900, 600)} alt="A small print" />);
    const [avif, webp] = [...container.querySelectorAll('source')];
    expect(avif.getAttribute('srcset')).toBe(`${url('w400', 'avif')} 400w, ${url('w800', 'avif')} 800w, ${url('w1200', 'avif')} 900w`);
    expect(webp.getAttribute('srcset')).toBe(`${url('w400', 'webp')} 400w, ${url('w800', 'webp')} 800w, ${url('w1200', 'webp')} 900w`);
    const tiny = render(<ResponsivePhoto asset={asset(300, 200)} alt="A thumbnail-sized original" />).container;
    expect(tiny.querySelector('source')?.getAttribute('srcset')).toBe(`${url('w400', 'avif')} 300w`);
  });

  it('leaves out the background without an LQIP, and sizes when none is given', () => {
    const { container } = render(<ResponsivePhoto asset={asset(3000, 2000, null)} alt="No placeholder" />);
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('style')).toBeNull();
    expect(container.querySelector('source')?.hasAttribute('sizes')).toBe(false);
    expect(img.hasAttribute('loading')).toBe(false);
  });

  it('forwards its ref to the image, and its error handler', () => {
    const ref = createRef<HTMLImageElement>();
    const onError = vi.fn();
    const { container } = render(<ResponsivePhoto ref={ref} asset={asset(3000, 2000)} alt="Ref target" onError={onError} className="gallery-photo" />);
    const img = container.querySelector('img') as HTMLImageElement;
    expect(ref.current).toBe(img);
    expect(img.className).toBe('gallery-photo');
    fireEvent.error(img);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('takes an empty alt for a decorative photo', () => {
    const { container } = render(<ResponsivePhoto asset={asset(3000, 2000)} alt="" />);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
  });

  it('requires alt', () => {
    // @ts-expect-error alt is required, even when it is empty.
    const element = <ResponsivePhoto asset={asset(3000, 2000)} />;
    expect(element.props).not.toHaveProperty('alt');
  });
});
