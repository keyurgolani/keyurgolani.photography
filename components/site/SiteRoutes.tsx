'use client';

import { useMemo, type ReactNode } from 'react';
import { createRouteBuilder } from '@/lib/catalog/routes';
import { SiteRoutesContext } from './siteRoutesContext';

/** Gives every client component under it the site's RouteBuilder for `basePath` (see siteRoutesContext.ts). */
export default function SiteRoutesProvider({ basePath, children }: { basePath: string; children: ReactNode }) {
    const routes = useMemo(() => createRouteBuilder({ basePath }), [basePath]);
    return <SiteRoutesContext.Provider value={routes}>{children}</SiteRoutesContext.Provider>;
}
