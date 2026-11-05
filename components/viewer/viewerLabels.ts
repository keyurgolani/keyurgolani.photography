// Interface copy and labels for the Viewer (#7). Nothing from the catalog, so
// the client component and its tests read them without pulling it in.

import { positionLabel as paddedPosition } from '../positionLabel';

export const CLOSE_LABEL = 'Close';
export const ZOOM_LABEL = 'Zoom';
/** The series page's missing-image copy (#5), for a photo whose revision holds no usable set. */
export const UNAVAILABLE_LABEL = 'Photograph unavailable';
/** A photograph whose file failed, its WebP retry included (#6): said above its alt, with Retry. */
export const FAILED_LABEL = 'This photograph could not be loaded.';
export const RETRY_LABEL = 'Retry';
export const PREVIOUS_LABEL = 'Previous photograph';
export const NEXT_LABEL = 'Next photograph';
export const DESCRIPTION_LABEL = 'Description';
export const SHOW_TECHNICAL = 'Show technical details';
export const HIDE_TECHNICAL = 'Hide technical details';
/** Says where the panel's facts come from, so they never read as authored copy. */
export const TECHNICAL_SOURCE = 'Read from the camera file';

/** #10's allowlisted keys, as the panel reads them. */
type TechnicalKey = 'Make' | 'Model' | 'LensModel' | 'FocalLength' | 'FNumber' | 'ExposureTime' | 'ISO';

/** The panel's rows, in #10's order, with the names a visitor reads. Make and Model share one row, Camera. */
export const TECHNICAL_LABELS = {
    camera: 'Camera',
    LensModel: 'Lens',
    FocalLength: 'Focal length',
    FNumber: 'Aperture',
    ExposureTime: 'Exposure',
    ISO: 'ISO',
} as const;

/** A stored number as written, when it is one: finite and above zero. Anything else is dropped from the panel. */
function positiveNumber(value: string | undefined): string | null {
    if (value === undefined || !/^\d+(\.\d+)?$/.test(value.trim())) return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? String(number) : null;
}

/** `1/200 s`, or `2 s` and `0.3 s`: #10 stores a whole reciprocal as `1/N`, anything else as a decimal. */
function exposure(value: string | undefined): string | null {
    const fraction = value === undefined ? null : /^1\/(\d+)$/.exec(value.trim());
    if (fraction) {
        const denominator = Number(fraction[1]);
        return Number.isFinite(denominator) && denominator > 0 ? `1/${denominator} s` : null;
    }
    const seconds = positiveNumber(value);
    return seconds === null ? null : `${seconds} s`;
}

/** Make and Model as one name, the make said once: `Canon EOS R5`, `NIKON Z 6` from `NIKON CORPORATION`, `SONY ILCE-7M3`. */
function camera(make: string | undefined, model: string | undefined): string | null {
    const [brand, name] = [make?.trim() || null, model?.trim() || null];
    if (brand === null || name === null) return name ?? brand;
    const first = (text: string) => text.split(/\s+/)[0].toLowerCase();
    return first(name) === first(brand) ? name : `${brand} ${name}`;
}

/** The technical panel's rows (#7): the camera's name, then each fact in its unit, and only what reads as a value. */
export function technicalFacts(technical: Partial<Record<TechnicalKey, string>>): { key: keyof typeof TECHNICAL_LABELS; label: string; value: string }[] {
    const focal = positiveNumber(technical.FocalLength);
    const aperture = positiveNumber(technical.FNumber);
    const iso = positiveNumber(technical.ISO);
    const lens = technical.LensModel?.trim() || null;
    const values: Record<keyof typeof TECHNICAL_LABELS, string | null> = {
        camera: camera(technical.Make, technical.Model),
        LensModel: lens,
        FocalLength: focal === null ? null : `${focal} mm`,
        FNumber: aperture === null ? null : `f/${aperture}`,
        ExposureTime: exposure(technical.ExposureTime),
        ISO: iso,
    };
    return (Object.keys(TECHNICAL_LABELS) as (keyof typeof TECHNICAL_LABELS)[]).flatMap((key) => {
        const value = values[key];
        return value === null ? [] : [{ key, label: TECHNICAL_LABELS[key], value }];
    });
}

/** The mockup's `NN / NN`, padded to the digits of the total (`007 / 120`), through the helper Home shares. */
export function positionLabel(position: number, total: number): string {
    return paddedPosition(position, total);
}

/**
 * The heading's name, its aria-label (#7): "{series}, photograph N of T", from the same title the heading shows. A
 * photograph named by its place has the bare title, since its image already says "Photograph N of T".
 */
export function headingLabel(seriesTitle: string, position: number, total: number, namedByPlace: boolean): string {
    return namedByPlace ? seriesTitle : `${seriesTitle}, photograph ${position} of ${total}`;
}

/** The same position for a screen reader, which would read the padded form as digits and a slash. */
export function positionText(position: number, total: number): string {
    return `Photograph ${position} of ${total}`;
}

/** The share and tab title: the authored title when there is one, else the series and the position. */
export function viewerTitle(photoTitle: string | null, seriesTitle: string, position: number, total: number): string {
    return photoTitle === null ? `${seriesTitle}, photograph ${position} of ${total}` : `${photoTitle}, ${seriesTitle}`;
}

/** One sentence, ended: authored copy may end itself, and anything else gets a full stop. */
function sentence(text: string): string {
    const trimmed = text.trim();
    return /[.!?…]["'’”)]?$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * What the live region says once a move settles (#178): the position, then the photograph's title and description
 * when it has them, so a visitor who moves by a key or a control hears what arrived. With neither, the position alone,
 * as before.
 */
export function moveText(position: number, total: number, title: string | null, description: string | null): string {
    const parts = [title, description].filter((part): part is string => part !== null && part.trim() !== '');
    if (parts.length === 0) return positionText(position, total);
    return [positionText(position, total), ...parts].map(sentence).join(' ');
}

/** A move asked for offline, by the controls and in the live region (#178). It doesn't navigate. */
export function offlineText(step: 'previous' | 'next'): string {
    return `You're offline. The ${step} photograph couldn't load.`;
}

/** A photograph unpublished, or moved to another series, while the Viewer had it open or was moving to it (#178). */
export const UNAVAILABLE_HEADING = 'This photograph is no longer here';
export const UNAVAILABLE_TEXT = 'It was unpublished or moved after this page loaded.';
export const UNAVAILABLE_BACK = 'Back to the series';
/** What the live region says for it: the heading and the sentence, since focus lands on the heading only. */
export const UNAVAILABLE_ANNOUNCEMENT = `${UNAVAILABLE_HEADING}. ${UNAVAILABLE_TEXT}`;

/** What the live region says when a move is asked for past an end. The Viewer doesn't wrap. */
export function boundaryText(step: 'previous' | 'next', seriesTitle: string): string {
    return step === 'previous' ? `First photograph in ${seriesTitle}.` : `Last photograph in ${seriesTitle}.`;
}

/** Only the form 13A's `accent.format` accepts, so nothing else reaches the inline custom property. */
export function accentValue(...candidates: (string | null)[]): string | null {
    return candidates.find((value): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) ?? null;
}
