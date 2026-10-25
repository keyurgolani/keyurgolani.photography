// The Viewer opened by a soft navigation from inside /work/<slug> (#9): the
// same answer as the direct page, from the same per-request lookup, its
// redirects and not-found included. ViewerHost decides whether it shows as a
// modal (over the series page) or in place of the page (a move on a directly
// loaded Viewer).

// Per request, never at build, like the page it re-exports. Segment config has to be written in this file.
export const dynamic = 'force-dynamic';

export { default, generateMetadata } from '@/app/work/[slug]/photo/[photoId]/page';
