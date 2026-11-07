// Per request, never at build: the image builds with no data root, so a build-time read would freeze the photograph.
// No generateStaticParams or revalidate, no loading.tsx here or above, and no Suspense around the lookup: a notFound()
// or redirect thrown after the shell streams turns into a 200, so both run before anything renders.
export const dynamic = 'force-dynamic';

export { ViewerRoute as default } from './viewerRoute';
export { generateMetadata } from './viewerLookup';
