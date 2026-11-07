import { render, type RenderOptions } from '@testing-library/react';
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import type { ReactElement, ReactNode } from 'react';

/** The router methods a test stubs: Work's entry links call prefetch alone. */
export type StubRouter = Partial<Record<keyof AppRouterInstance, unknown>>;

/**
 * Mounts `router` as the app router, in the context next/navigation's useRouter() and Link read, the one Next's app
 * router provides. A component that reads the router from it, as Work's entry links do, sees `router`.
 */
export function withAppRouter(router: StubRouter) {
    return function AppRouter({ children }: { children: ReactNode }) {
        return <AppRouterContext.Provider value={router as AppRouterInstance}>{children}</AppRouterContext.Provider>;
    };
}

/** Testing Library's render, inside `router` as the app router. A rerender stays inside it. */
export function renderInAppRouter(router: StubRouter, ui: ReactElement, options: Omit<RenderOptions, 'wrapper'> = {}) {
    return render(ui, { ...options, wrapper: withAppRouter(router) });
}
