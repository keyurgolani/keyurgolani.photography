// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cameraSettingsCaption } from '../legacy-photos';

describe('cameraSettingsCaption', () => {
    it('joins the model and settings the way the legacy Gallery caption does', () => {
        expect(cameraSettingsCaption({ Make: 'Fixture Make', Model: 'Fixture Model', FocalLength: '35', FNumber: '1.8', ExposureTime: '1/200', ISO: '100' }))
            .toBe('Fixture Model | 35mm f/1.8 1/200s ISO 100');
    });

    it.each([
        [{ Model: 'Fixture Model' }, 'Fixture Model'],
        [{ FocalLength: '50', FNumber: '2' }, '50mm f/2'],
        [{ Model: 'Fixture Model', ExposureTime: '2' }, 'Fixture Model | 2s'],
        [{ Make: 'Fixture Make' }, ''],
        [{}, ''],
    ])('leaves out what is missing: %j', (technical, caption) => {
        expect(cameraSettingsCaption(technical)).toBe(caption);
    });
});
