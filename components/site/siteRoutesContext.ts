'use client';

import { createContext, useContext } from 'react';
import { createRouteBuilder, type RouteBuilder } from '@/lib/catalog/routes';

/**
 * The site's RouteBuilder on the client. Functions can't cross from a
 * server component to a client one, so the server passes `basePath` and
 * SiteRoutesProvider rebuilds the same builder from it. Without a provider
 * it's the public site's (`basePath` `''`). #16's preview wraps its visitor
 * site in one, so every href a client component builds stays inside the
 * preview.
 */
export const SiteRoutesContext = createContext<RouteBuilder>(createRouteBuilder());

export function useSiteRoutes(): RouteBuilder {
    return useContext(SiteRoutesContext);
}
