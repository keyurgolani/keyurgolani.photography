import { expect, type Page } from '@playwright/test';
import { makeCuratorSecrets } from '../../test/helpers/curatorSecrets';
import { startCatalogServer, type CatalogServer, type CatalogServerOptions } from './catalogServer';
import { waitForHydration } from './hydration';

/**
 * The curator (#14) for e2e: a catalog server with the flag on and test
 * secret files, a passphrase made for this run and never printed. signIn()
 * logs a page in through the login form, the way the owner does.
 */

export interface CuratorServer extends CatalogServer {
    /** The test passphrase the server's hash was made from. */
    passphrase: string;
}

/** `env` adds curator settings, such as LAN mode's CURATOR_PUBLISH. The secret file paths are always the test ones. */
export async function startCuratorServer(dataRoot: string, port?: number, options: Omit<CatalogServerOptions, 'curator'> = {}): Promise<CuratorServer> {
    const secrets = await makeCuratorSecrets();
    let server: CatalogServer;
    try {
        server = await startCatalogServer(dataRoot, port, { ...options, curator: true, env: { ...options.env, ...secrets.env } });
    } catch (error) {
        secrets.cleanup();
        throw error;
    }
    return {
        ...server,
        passphrase: secrets.passphrase,
        stop: async () => {
            await server.stop();
            secrets.cleanup();
        },
    };
}

/** Opens `origin`'s login page and signs in with `passphrase`, ending on /curation. */
export async function signIn(page: Page, origin: string, passphrase: string): Promise<void> {
    await page.goto(`${origin}/curation/login`);
    await waitForHydration(page);
    await page.getByLabel('Passphrase').fill(passphrase);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(`${origin}/curation`);
}
