import type { Metadata } from 'next';
import { headers } from 'next/headers';
import SiteNav from '@/components/site/SiteNav';
import SeriesCatalog from '@/components/work/SeriesCatalog';
import { workRouteOf } from '@/lib/catalog/projections/work';
import { CatalogUnavailableError, getActiveCatalog, publicRoutes } from '@/lib/catalog/public-reader';
import { getSiteOrigin } from '@/lib/site/config';

// Per request, never at build: the image builds with no data root, so a build-time read would freeze Work.
export const dynamic = 'force-dynamic';

const readWork = async () => workRouteOf(await getActiveCatalog(), publicRoutes);

/** Each request's answer, by its headers object, which Next keeps for the whole request. */
const answers = new WeakMap<object, ReturnType<typeof readWork>>();

/**
 * The page's one answer in this request, shared by the page and
 * generateMetadata, so the two never disagree. It's kept by the request, not
 * by cache(), whose scope is one render: when the page throws, Next renders
 * the error page's head in a second render, and a fresh catalog read there
 * would land Work's metadata after the error shell was sent. Next then
 * streams the title into the body, where a visitor without JavaScript keeps
 * it. Kept, the answer is there at once.
 */
async function workFor(): ReturnType<typeof readWork> {
    const request = await headers();
    let answer = answers.get(request);
    if (answer === undefined) {
        answer = readWork();
        answers.set(request, answer);
    }
    return answer;
}

/**
 * Work's own title, description, and canonical path (#3), through the root
 * layout's title template and metadataBase. While the catalog is unavailable
 * it gives `{}`, as the series pages do, so #21's error page keeps the site's
 * defaults with its 500. Without a valid SITE_URL the base is localhost, so
 * the canonical link is left out, as on the series and Viewer pages.
 */
export async function generateMetadata(): Promise<Metadata> {
    if ((await workFor()).kind !== 'work') return {};
    return {
        title: 'Work',
        description: 'Photographic series by Keyur Golani.',
        ...(getSiteOrigin() !== null && { alternates: { canonical: '/work' } }),
    };
}

/**
 * The series catalog (#3): the served revision's published series. With
 * nothing published, or a catalog that can't be read, it throws, so #21's
 * error page renders with its Try again.
 */
export default async function WorkPage() {
    const result = await workFor();
    switch (result.kind) {
        case 'unavailable':
            throw new CatalogUnavailableError(result.reason);
        case 'work':
            return (
                <>
                    {/* Outside main, so the nav landmark isn't part of the page's content. */}
                    <SiteNav />
                    <SeriesCatalog work={result.work} />
                </>
            );
    }
}
