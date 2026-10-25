import { createMediaHandler } from '@/lib/media/handler';

/** Derivative sets from the data root. See lib/media/handler.ts. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = createMediaHandler();
