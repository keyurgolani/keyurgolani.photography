import type { TechnicalKey } from '../identity/metadata';
import type { PhotoRecord } from '../identity/types';

/**
 * Whether the legacy site can list a photo, by the registry alone: present at
 * the library's top level, not merged into another, with a decodable
 * observed revision. legacyList() also needs its seven derivatives on disk,
 * and lists one photo per shared set name, so it can list fewer.
 */
export function onLegacySite(photo: PhotoRecord): boolean {
    if (!photo.source.present || photo.sourceHealth !== 'present' || photo.mergedInto !== undefined || photo.source.path.includes('/')) return false;
    const revision = photo.revisions[photo.source.observedRevision];
    return revision !== undefined && revision.width !== null && revision.height !== null;
}

/**
 * The caption the legacy Gallery builds from camera settings, such as
 * "Model | 35mm f/1.8 1/200s ISO 100", from #10's stored technical values.
 * Legacy /api/photos keeps it as `caption`. It is never a description, so the
 * description rules refuse alt text that equals it.
 */
export function cameraSettingsCaption(technical: Partial<Record<TechnicalKey, string>>): string {
    const settings: string[] = [];
    if (technical.FocalLength) settings.push(`${technical.FocalLength}mm`);
    if (technical.FNumber) settings.push(`f/${technical.FNumber}`);
    if (technical.ExposureTime) settings.push(`${technical.ExposureTime}s`);
    if (technical.ISO) settings.push(`ISO ${technical.ISO}`);
    const camera = technical.Model ?? '';
    if (settings.length === 0) return camera;
    return camera ? `${camera} | ${settings.join(' ')}` : settings.join(' ');
}
