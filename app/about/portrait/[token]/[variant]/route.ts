import { createPortraitHandler } from '@/lib/siteConfig/portraitVariants';

/**
 * About's portrait, from the site config folder on the host, at
 * `/about/portrait/<token>/<variant>.<format>`. See lib/siteConfig/portraitVariants.ts.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = createPortraitHandler();
