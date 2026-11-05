import { photoSizes, type Fit } from '@/components/photoSizes';

/**
 * Home's slide fills the viewport (HomeSequence.module.css), so #6's size
 * rule gives a cover crop the wider of the viewport and the photograph at
 * the viewport's height, and a contain one the narrower. Light's and
 * Bright's margin draws the box a few percent smaller, which this leaves out.
 * A plain module, so the tests and the client slide read the same value.
 */
export function heroSizes(image: { width: number; height: number }, fit: Fit = 'cover'): string {
    return photoSizes(image, fit, [{ vw: 100, heightVh: 100 }]);
}
