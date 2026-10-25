// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assertPublishableCopy, PROVISIONAL_COPY_MESSAGE } from '../artistProfile';

const provisional = { copyStatus: 'provisional' } as const;
const approved = { copyStatus: 'approved' } as const;

describe('assertPublishableCopy', () => {
  it('throws for provisional copy in a production build without the override', () => {
    expect(() => assertPublishableCopy(provisional, { NODE_ENV: 'production' })).toThrow(PROVISIONAL_COPY_MESSAGE);
  });

  it('takes only the exact override value', () => {
    for (const value of ['0', 'true', 'yes', '', ' 1']) {
      expect(() => assertPublishableCopy(provisional, { NODE_ENV: 'production', ALLOW_PROVISIONAL_COPY: value }), value).toThrow(PROVISIONAL_COPY_MESSAGE);
    }
    expect(() => assertPublishableCopy(provisional, { NODE_ENV: 'production', ALLOW_PROVISIONAL_COPY: '1' })).not.toThrow();
  });

  it('lets next dev and the tests run on the placeholder', () => {
    for (const NODE_ENV of ['development', 'test', undefined]) {
      expect(() => assertPublishableCopy(provisional, { NODE_ENV })).not.toThrow();
    }
  });

  it('never throws for approved copy', () => {
    expect(() => assertPublishableCopy(approved, { NODE_ENV: 'production' })).not.toThrow();
  });
});
