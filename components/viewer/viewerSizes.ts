import { heightCappedSizes } from '@/components/photoSizes';

/**
 * The fitted photograph is at most about four fifths of a wide viewport and
 * the full width of a narrow one, and no taller than the first screen, as
 * StoryViewer.module.css sizes its box. With the height cap, a tall
 * photograph on a wide screen asks for the rung it renders at (#6).
 */
export const fitSizes = (width: number, height: number) =>
    heightCappedSizes(width, height, 100, [{ media: '(min-width: 48rem)', vw: 80 }, { vw: 100 }]);
