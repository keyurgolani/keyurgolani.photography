import { heightCappedSizes } from '@/components/photoSizes';

/**
 * The fitted photograph is at most about four fifths of a wide viewport and
 * the full width of a narrow one, and no taller than the first screen, as
 * StoryViewer.module.css sizes its box. With the height cap, a tall
 * photograph on a wide screen asks for the rung it renders at (#6).
 *
 * On a wide screen under 40rem tall (a phone held sideways), the header and
 * the stage's padding (7.5rem) are a large share of the height, and the box
 * keeps the rest, with no room for the title line (#9b). The cap takes them
 * off there, so the photograph asks for the rung it's drawn at, not one up.
 * On a taller wide screen the share alone stays a little over the box, room
 * for the title line included, which keeps #6's rungs as they were.
 */
export const fitSizes = (width: number, height: number) =>
    heightCappedSizes(width, height, 100, [
        { media: '(min-width: 48rem) and (max-height: 39.99rem)', vw: 80, offsetRem: 7.5 },
        { media: '(min-width: 48rem)', vw: 80 },
        { vw: 100 },
    ]);
