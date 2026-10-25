import type { ArtistProfile } from '../data/artist';

export const PROVISIONAL_COPY_MESSAGE =
  'data/artist.ts: About copy is provisional. Replace the statement, alias, alt text, and biography ' +
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
