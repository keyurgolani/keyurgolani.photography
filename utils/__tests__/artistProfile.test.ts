// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { artist, type ArtistProfile } from '../../data/artist';
import { assertPublishableCopy, PROVISIONAL_COPY_MESSAGE, validateArtistProfile } from '../artistProfile';

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

describe('validateArtistProfile', () => {
  const valid: ArtistProfile = {
    copyStatus: 'approved',
    name: 'A Name',
    alias: 'AnAlias',
    statementHeading: 'A heading',
    statementParagraphs: ['First paragraph.', 'Second paragraph.'],
    shortBiography: 'A short biography.',
  };
  const check = (overrides: Partial<ArtistProfile>) => validateArtistProfile({ ...valid, ...overrides });

  // The real profile, so a broken copy edit to data/artist.ts fails npm test.
  it('accepts the real profile in data/artist.ts', () => {
    expect(validateArtistProfile(artist.profile)).toEqual([]);
  });

  it('accepts a valid profile, and one with no alias or biography', () => {
    expect(validateArtistProfile(valid)).toEqual([]);
    expect(validateArtistProfile({ ...valid, alias: undefined, shortBiography: undefined })).toEqual([]);
  });

  it.each<[string, Partial<ArtistProfile>, string]>([
    ['an empty name', { name: '' }, 'name is empty'],
    ['a blank heading', { statementHeading: '   ' }, 'statementHeading is empty'],
    ['no paragraphs', { statementParagraphs: [] }, 'statementParagraphs has no paragraph'],
    ['an empty paragraph', { statementParagraphs: ['First paragraph.', ''] }, 'statementParagraphs[1] is empty'],
    ['a present but empty biography', { shortBiography: '' }, 'shortBiography is empty'],
    ['a present but empty alias', { alias: ' ' }, 'alias is empty'],
    ['space around the heading', { statementHeading: ' A heading' }, 'statementHeading starts or ends with space'],
    ['markup in a paragraph', { statementParagraphs: ['<b>bold</b>'] }, 'statementParagraphs[0] holds markup (< or >)'],
    ['a < in the heading', { statementHeading: 'A < B' }, 'statementHeading holds markup (< or >)'],
    ['a > in the biography', { shortBiography: 'A > B' }, 'shortBiography holds markup (< or >)'],
    ['an unknown copy status', { copyStatus: 'draft' as ArtistProfile['copyStatus'] }, "copyStatus is neither 'provisional' nor 'approved'"],
  ])('rejects %s', (_case, overrides, problem) => {
    expect(check(overrides)).toEqual([problem]);
  });

  it('reports every problem at once', () => {
    expect(check({ name: '', statementHeading: '', statementParagraphs: [] })).toEqual(['name is empty', 'statementHeading is empty', 'statementParagraphs has no paragraph']);
  });
});
