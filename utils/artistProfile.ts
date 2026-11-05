import type { ArtistProfile } from '../data/artist';

export const PROVISIONAL_COPY_MESSAGE =
  'data/artist.ts: About copy is provisional. Replace the statement, alias, and biography ' +
  "with owner-approved copy and set copyStatus to 'approved'.";

/**
 * Refuses to publish About while its copy is the provisional placeholder.
 * `app/about/page.tsx` calls it at module scope, where `next build` evaluates
 * it, so a production build fails. `next dev` and Vitest run on the
 * placeholder. `ALLOW_PROVISIONAL_COPY=1` is for the Playwright servers only,
 * never the Dockerfile, Compose files, or workflows.
 */
export function assertPublishableCopy(profile: Pick<ArtistProfile, 'copyStatus'>, env: Record<string, string | undefined> = process.env): void {
  if (profile.copyStatus === 'approved') return;
  if (env.NODE_ENV !== 'production') return;
  if (env.ALLOW_PROVISIONAL_COPY === '1') return;
  throw new Error(PROVISIONAL_COPY_MESSAGE);
}

/**
 * Every problem with About's authored copy in `data/artist.ts`, one line
 * each, or none. Name, alias, heading, each paragraph, and the biography are
 * plain text: none is blank or padded with space, and none holds `<` or `>`.
 * An alias or a biography may be absent, but not present and empty. There is
 * at least one paragraph. The portrait's alt, size, and focal point are files
 * on the host, which `lib/siteConfig/aboutPortrait.ts` checks as it reads
 * them. `utils/__tests__/artistProfile.test.ts` runs this on the real profile,
 * so a broken copy edit fails `npm test`.
 */
export function validateArtistProfile(profile: ArtistProfile): string[] {
  const problems: string[] = [];
  const text = (field: string, value: string) => {
    if (value.trim() === '') {
      problems.push(`${field} is empty`);
      return;
    }
    if (value !== value.trim()) problems.push(`${field} starts or ends with space`);
    if (/[<>]/.test(value)) problems.push(`${field} holds markup (< or >)`);
  };
  if (profile.copyStatus !== 'provisional' && profile.copyStatus !== 'approved') problems.push("copyStatus is neither 'provisional' nor 'approved'");
  text('name', profile.name);
  if (profile.alias !== undefined) text('alias', profile.alias);
  text('statementHeading', profile.statementHeading);
  if (profile.statementParagraphs.length === 0) problems.push('statementParagraphs has no paragraph');
  profile.statementParagraphs.forEach((paragraph, index) => text(`statementParagraphs[${index}]`, paragraph));
  if (profile.shortBiography !== undefined) text('shortBiography', profile.shortBiography);
  return problems;
}
