// Interface copy and labels for the Viewer (#7). No imports, so the client
// component and its tests read them without pulling in the catalog.

export const CLOSE_LABEL = 'Close';
export const ZOOM_LABEL = 'Zoom';
/** The series page's missing-image copy (#5), for a photo whose revision holds no usable set. */
export const UNAVAILABLE_LABEL = 'Photograph unavailable';
export const PREVIOUS_LABEL = 'Previous photograph';
export const NEXT_LABEL = 'Next photograph';
export const DESCRIPTION_LABEL = 'Description';
export const SHOW_TECHNICAL = 'Show technical details';
export const HIDE_TECHNICAL = 'Hide technical details';
/** Says where the panel's facts come from, so they never read as authored copy. */
export const TECHNICAL_SOURCE = 'Read from the camera file';

/** #10's allowlisted keys, in its order, with the names a visitor reads. */
export const TECHNICAL_LABELS = {
    Make: 'Camera make',
    Model: 'Camera',
    LensModel: 'Lens',
    FocalLength: 'Focal length',
    FNumber: 'Aperture',
    ExposureTime: 'Exposure',
    ISO: 'ISO',
} as const;

/** The mockup's `NN / NN`: both numbers padded to two digits. */
export function positionLabel(position: number, total: number): string {
    return `${String(position).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
}

/** The same position for a screen reader, which would read the padded form as digits and a slash. */
export function positionText(position: number, total: number): string {
    return `Photograph ${position} of ${total}`;
}

/** The share and tab title: the authored title when there is one, else the series and the position. */
export function viewerTitle(photoTitle: string | null, seriesTitle: string, position: number, total: number): string {
    return photoTitle === null ? `${seriesTitle}, photograph ${position} of ${total}` : `${photoTitle}, ${seriesTitle}`;
}

/** Only the form 13A's `accent.format` accepts, so nothing else reaches the inline custom property. */
export function accentValue(...candidates: (string | null)[]): string | null {
    return candidates.find((value): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) ?? null;
}
