import type { TechnicalKey } from '../identity/metadata';

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
