// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { folderBytes } from '../test/helpers/folderBytes';
import { REPO_ROOT } from '../test/helpers/runTsx';
import { isCuratorFile, routeInventory } from '../test/helpers/routeInventory';
import { setDataDir } from '../test/helpers/tempDataRoot';

// #14's 14-2 route inventory. No app/ handler but GET or HEAD, and no
// 'use server' file, lives outside the curator prefixes, and every curator
// entry point runs requireCurator() first. Then every curator action, and
// every curator page, is called with each of the boundary's checks failing,
// and none of them writes anything.

/** The request headers requireCurator() reads through next/headers. */
let requestHeaders = new Headers();
vi.mock('next/headers', () => ({ headers: async () => requestHeaders }));

const CURATOR_HOST = '127.0.0.1:3001';
const ALLOWED = { host: CURATOR_HOST, origin: `http://${CURATOR_HOST}`, 'next-action': '7f'.repeat(21) };

/** Each way the boundary refuses a curator action: the env it runs with and the headers it gets. */
const REFUSALS: { name: string; env: Record<string, string>; headers: Record<string, string> }[] = [
    { name: 'the flag off', env: { CURATION_ENABLED: 'false' }, headers: ALLOWED },
    { name: 'the flag unset', env: {}, headers: ALLOWED },
    { name: 'a wrong Host', env: { CURATION_ENABLED: 'true' }, headers: { ...ALLOWED, host: 'rebound.example:3001', origin: 'http://rebound.example:3001' } },
    { name: 'no Host', env: { CURATION_ENABLED: 'true' }, headers: { origin: ALLOWED.origin, 'next-action': ALLOWED['next-action'] } },
    { name: 'a missing Origin', env: { CURATION_ENABLED: 'true' }, headers: { host: CURATOR_HOST, 'next-action': ALLOWED['next-action'] } },
    { name: 'a wrong Origin', env: { CURATION_ENABLED: 'true' }, headers: { ...ALLOWED, origin: 'https://attacker.example' } },
    { name: 'Origin null', env: { CURATION_ENABLED: 'true' }, headers: { ...ALLOWED, origin: 'null' } },
    { name: 'a non-loopback bind', env: { CURATION_ENABLED: 'true', HOSTNAME: '0.0.0.0' }, headers: ALLOWED },
];

const isNotFound = (error: unknown) =>
    typeof error === 'object' && error !== null && 'digest' in error && String((error as { digest: unknown }).digest).startsWith('NEXT_HTTP_ERROR_FALLBACK;404');

let tempRoot: string;
let dataRoot: string;
let library: string;
let restoreDataDir: () => void;

beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-inventory-'));
    dataRoot = path.join(tempRoot, 'data');
    library = path.join(tempRoot, 'library');
    fs.mkdirSync(path.join(dataRoot, 'curation'), { recursive: true });
    fs.mkdirSync(library);
    fs.writeFileSync(path.join(dataRoot, 'data-root.json'), '{"marker":true}\n');
    fs.writeFileSync(path.join(library, 'a.jpg'), 'jpeg bytes');
    restoreDataDir = setDataDir(dataRoot);
    vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', library);
});

afterEach(() => {
    vi.unstubAllEnvs();
    restoreDataDir();
    requestHeaders = new Headers();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** Run `call` with `refusal`'s env and headers, and return what the data root and the library hold after. */
async function attempt(refusal: (typeof REFUSALS)[number], call: () => Promise<unknown>) {
    vi.stubEnv('CURATION_ENABLED', refusal.env.CURATION_ENABLED);
    vi.stubEnv('HOSTNAME', refusal.env.HOSTNAME ?? '127.0.0.1');
    vi.stubEnv('CURATOR_TUNNEL_PORT', '');
    vi.stubEnv('CURATION_BIND_SCOPE', '');
    requestHeaders = new Headers(refusal.headers);
    let outcome: unknown = 'resolved';
    try {
        await call();
    } catch (error) {
        outcome = error;
    }
    return outcome;
}

const snapshot = () => ({ data: folderBytes(dataRoot), library: folderBytes(library) });

describe('the route inventory', () => {
    const inventory = routeInventory(REPO_ROOT);

    it('finds no mutating handler or server action outside the curator prefixes, and every curator entry point guarded', () => {
        expect(inventory.violations).toEqual([]);
    });

    it('sees the public read handlers, so it is reading the tree', () => {
        expect(inventory.handlers).toEqual(expect.arrayContaining(['app/api/health/route.ts#GET', 'app/api/photos/route.ts#GET']));
        expect(inventory.handlers.every((handler) => /#(GET|HEAD)$/.test(handler) || handler.startsWith('app/api/curation/'))).toBe(true);
    });

    describe('on a tree that breaks the rules', () => {
        let tree: string;

        beforeEach(() => {
            tree = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-tree-'));
        });
        afterEach(() => {
            fs.rmSync(tree, { recursive: true, force: true });
        });

        const write = (file: string, text: string) => {
            fs.mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
            fs.writeFileSync(path.join(tree, file), text);
        };

        /** The import every guarded curator file carries. */
        const G = "import { requireCurator } from '@/lib/curation/auth';\n";
        const DYN = "export const dynamic = 'force-dynamic';\n";
        const GUARDED_PAGE = `${G}${DYN}export default async function P() { await requireCurator({ read: true }); return null; }\n`;

        it.each([
            ['a POST handler outside the prefixes', 'app/api/photos/route.ts', 'export async function POST() { return new Response(); }\n', 'mutating handler'],
            ['a re-exported DELETE handler', 'app/api/x/route.ts', 'async function d() { return new Response(); }\nexport { d as DELETE };\n', 'mutating handler'],
            ['a PUT const handler', 'app/x/route.ts', 'export const PUT = make();\n', 'mutating handler'],
            ["a 'use server' file outside the prefixes", 'lib/actions.ts', "'use server';\nexport async function go() {}\n", "'use server'"],
            ["a 'use server' file in components", 'components/form.tsx', "'use server';\nexport async function go() {}\n", "'use server'"],
            ['an inline action in a public page', 'app/page.tsx', "export default function Page() { async function go() { 'use server'; } return null; }\n", "'use server'"],
            ['a curator action that writes before the guard', 'app/curation/actions.ts', `'use server';\n${G}export async function go() { write(); await requireCurator(); }\n`, 'server action'],
            ['a curator action with a read guard', 'app/curation/actions.ts', `'use server';\n${G}export async function go() { await requireCurator({ read: true }); }\n`, 'server action'],
            ['a curator action that never awaits the guard', 'app/curation/actions.ts', `'use server';\n${G}export async function go() { requireCurator(); }\n`, 'server action'],
            ['a curator action re-exported from elsewhere', 'app/curation/actions.ts', "'use server';\nexport { go } from '@/lib/elsewhere';\n", "can't be checked"],
            ['an unguarded inline curator action', 'app/curation/inbox/page.tsx', `${G}${DYN}export default async function P() { await requireCurator({ read: true }); async function go() { 'use server'; save(); } return null; }\n`, 'server action'],
            ['an unguarded curator page', 'app/curation/inbox/page.tsx', `${DYN}export default async function P() { return null; }\n`, 'renders curator content'],
            ['an unguarded curator layout', 'app/curation/layout.tsx', 'export default function L({ children }) { return children; }\n', 'renders curator content'],
            ['an unguarded curator template', 'app/curation/template.tsx', 'export default function T({ children }) { return children; }\n', 'renders curator content'],
            ['unguarded curator metadata', 'app/curation/inbox/page.tsx', `${G}${DYN}export async function generateMetadata() { return {}; }\nexport default async function P() { await requireCurator({ read: true }); return null; }\n`, 'generateMetadata'],
            ['a curator page that may be prerendered', 'app/curation/inbox/page.tsx', `${G}export default async function P() { await requireCurator({ read: true }); return null; }\n`, 'force-dynamic'],
            ['a curator POST handler with a read guard', 'app/api/curation/x/route.ts', `${G}${DYN}export async function POST() { await requireCurator({ read: true }); }\n`, 'curator handler'],
            ['an unguarded curator GET handler', 'app/api/curation/x/route.ts', `${DYN}export async function GET() { return new Response(); }\n`, 'curator handler'],
            ['a curator handler built by a factory', 'app/api/curation/x/route.ts', `${DYN}export const POST = make();\n`, 'curator handler'],
            // The URL decides, not the folder: route groups and parallel slots serve the same paths.
            ['an unguarded curator page in a route group', 'app/(curator)/curation/page.tsx', `${DYN}export default async function P() { return null; }\n`, 'renders curator content'],
            ['an unguarded curator page in nested route groups', 'app/(a)/(b)/curation/inbox/page.tsx', `${DYN}export default async function P() { return null; }\n`, 'renders curator content'],
            ['an unguarded curator page in a parallel slot', 'app/@panel/curation/page.tsx', `${DYN}export default async function P() { return null; }\n`, 'renders curator content'],
            ['an unguarded curator handler in a route group', 'app/(curator)/api/curation/x/route.ts', `${DYN}export async function GET() { return new Response(); }\n`, 'curator handler'],
            ['a top-level dynamic segment, which can serve curator paths', 'app/[section]/page.tsx', 'export default async function P() { return null; }\n', 'can serve curator paths'],
            ['a dynamic segment under /api, which can serve curator paths', 'app/api/[name]/route.ts', 'export async function GET() { return new Response(); }\n', 'can serve curator paths'],
            // A folder Next serves at another level's URL still counts by the URL it serves.
            ['an unguarded page Next serves at /curation from one level down', 'app/photos/(..)curation/page.tsx', `${DYN}export default async function P() { return null; }\n`, 'renders curator content'],
            ['an unguarded page Next serves at /curation from two levels down', 'app/a/b/(..)(..)curation/page.tsx', `${DYN}export default async function P() { return null; }\n`, 'renders curator content'],
            ['an unguarded page Next serves at /curation from deep in the tree', 'app/gallery/x/(...)curation/page.tsx', `${DYN}export default async function P() { return null; }\n`, 'renders curator content'],
            ['an unguarded page Next serves at /curation/inbox from a route group', 'app/(shop)/photos/(..)curation/inbox/page.tsx', `${DYN}export default async function P() { return null; }\n`, 'renders curator content'],
            ['an unguarded page Next serves at a curator path from its own level', 'app/curation/(.)inbox/page.tsx', `${DYN}export default async function P() { return null; }\n`, 'renders curator content'],
            ['an unguarded page in a curator folder Next serves elsewhere', 'app/curation/(..)photos/page.tsx', `${DYN}export default async function P() { return null; }\n`, 'renders curator content'],
            ['a top-level dynamic segment Next serves from one level down', 'app/x/(..)[y]/page.tsx', 'export default async function P() { return null; }\n', 'can serve curator paths'],
            // Every convention file under a curator path.
            ['a curator not-found page that reads data', 'app/curation/not-found.tsx', "import { readThing } from '@/lib/catalog/thing';\nexport default async function N() { await readThing(); return null; }\n", 'fallback'],
            ['a curator loading state that reads data', 'app/curation/loading.tsx', "import fs from 'node:fs';\nexport default function L() { fs.readFileSync('x'); return null; }\n", 'fallback'],
            ['a curator error boundary that is not a client component', 'app/curation/error.tsx', 'export default function E() { return null; }\n', "'use client'"],
            ['a curator error boundary that reads data', 'app/curation/error.tsx', "'use client';\nimport { thing } from '../../lib/thing';\nexport default function E() { return thing; }\n", 'fallback'],
            ['an unguarded curator share image', 'app/curation/opengraph-image.tsx', `${DYN}export default async function Image() { return new Response(); }\n`, 'renders curator content'],
            ['an unguarded curator icon', 'app/curation/icon.tsx', `${DYN}export default function Icon() { return new Response(); }\n`, 'renders curator content'],
            ['an unguarded curator sitemap', 'app/curation/sitemap.ts', `${DYN}export default function sitemap() { return []; }\n`, 'renders curator content'],
            ['a curator share image that may be prerendered', 'app/curation/twitter-image.tsx', `${G}export default async function Image() { await requireCurator({ read: true }); return new Response(); }\n`, 'force-dynamic'],
            ['a curator page with static params', 'app/curation/[id]/page.tsx', `${GUARDED_PAGE}export function generateStaticParams() { return []; }\n`, 'generateStaticParams'],
            // The guard has to be the real one.
            ['a guard imported from elsewhere', 'app/curation/page.tsx', `import { requireCurator } from './guard';\n${DYN}export default async function P() { await requireCurator({ read: true }); return null; }\n`, '@/lib/curation/auth'],
            ['a guard that is another function renamed', 'app/curation/page.tsx', `import { other as requireCurator } from '@/lib/curation/auth';\n${DYN}export default async function P() { await requireCurator({ read: true }); return null; }\n`, '@/lib/curation/auth'],
            ['a guard that is never imported', 'app/curation/page.tsx', `${DYN}export default async function P() { await requireCurator({ read: true }); return null; }\n`, '@/lib/curation/auth'],
            ['a guard declared in the file', 'app/curation/page.tsx', `${DYN}async function requireCurator(o) {}\nexport default async function P() { await requireCurator({ read: true }); return null; }\n`, '@/lib/curation/auth'],
        ])('fails on %s', (_, file, text, message) => {
            write(file, text);
            const { violations } = routeInventory(tree);
            expect(violations).toHaveLength(1);
            expect(violations[0]).toContain(message);
        });

        it.each([
            ['a public page', 'app/page.tsx', "import { go } from './curation/actions';\nexport default function P() { return null; }\n"],
            ['a public page through the alias', 'app/work/page.tsx', "import { go } from '@/app/curation/actions';\nexport default function P() { return null; }\n"],
            ['a component', 'components/Form.tsx', "import { go } from '../app/curation/actions';\nexport const Form = () => null;\n"],
            ['a dynamic import in a library', 'lib/thing.ts', "export const load = () => import('@/app/curation/actions');\n"],
        ])('fails when %s imports a curator action', (_, file, text) => {
            write('app/curation/actions.ts', `'use server';\n${G}export async function go() { await requireCurator(); }\n`);
            write(file, text);
            const { violations } = routeInventory(tree);
            expect(violations).toHaveLength(1);
            expect(violations[0]).toContain('imports a curator action');
        });

        it('passes guarded curator pages, handlers, actions and convention files, in groups and slots too', () => {
            write('app/curation/inbox/page.tsx', `${G}${DYN}export default async function P() { await requireCurator({ read: true }); async function go() { 'use server'; await requireCurator(); } return null; }\n`);
            write('app/curation/actions.ts', `'use server';\n${G}export async function go() { await requireCurator(); }\nexport const stop = async () => { const access = await requireCurator(); };\n`);
            write('app/curation/inbox/client.tsx', "'use client';\nimport { go } from '../actions';\nexport const Button = () => null;\n");
            write('app/api/curation/x/route.ts', `${G}${DYN}export async function GET() { await requireCurator({ read: true }); }\nexport async function POST() { await requireCurator(); }\n`);
            write('app/(curator)/curation/review/page.tsx', GUARDED_PAGE);
            write('app/(curator)/curation/layout.tsx', `${G}export default async function L({ children }) { await requireCurator({ read: true }); return children; }\n`);
            write('app/curation/not-found.tsx', "import Link from 'next/link';\nimport StatusPage from '@/components/site/StatusPage';\nexport default function N() { return null; }\n");
            write('app/curation/loading.tsx', "import styles from './loading.module.css';\nexport default function L() { return null; }\n");
            write('app/curation/error.tsx', "'use client';\nimport { useEffect } from 'react';\nexport default function E() { return null; }\n");
            write('app/curation/opengraph-image.tsx', `${G}${DYN}export default async function Image() { await requireCurator({ read: true }); return new Response(); }\n`);
            write('app/api/photos/route.ts', 'export async function GET() { return new Response(); }\n');
            write('app/work/[slug]/page.tsx', 'export default async function P() { return null; }\n');
            const inventory = routeInventory(tree);
            expect(inventory.violations).toEqual([]);
            expect(inventory.actions).toEqual(['app/curation/actions.ts', 'app/curation/inbox/page.tsx#go']);
        });
    });
});

describe('every curator action, called with the boundary failing', () => {
    const inventory = routeInventory(REPO_ROOT);
    // 14-3 adds the first real ones. The probe stands in until then, and stays, so the harness is checked against a write.
    const actionFiles = [...new Set(inventory.actions.map((action) => action.split('#')[0]))].filter((file) => !/\/page\.[jt]sx?$/.test(file));

    it('lists only files under the curator prefixes', () => {
        for (const file of actionFiles) expect(isCuratorFile(file)).toBe(true);
    });

    const targets = [
        { label: 'test/fixtures/curatorProbeAction.ts', load: () => import('../test/fixtures/curatorProbeAction') },
        ...actionFiles.map((file) => ({ label: file, load: () => import(/* @vite-ignore */ path.join(REPO_ROOT, file)) })),
    ];

    for (const target of targets) {
        it.each(REFUSALS.map((refusal) => [refusal.name, refusal] as const))(`${target.label} writes nothing with %s`, async (_, refusal) => {
            const module = (await target.load()) as Record<string, unknown>;
            const actions = Object.entries(module).filter(([, value]) => typeof value === 'function') as [string, () => Promise<unknown>][];
            expect(actions.length).toBeGreaterThan(0);
            for (const [name, action] of actions) {
                const before = snapshot();
                const outcome = await attempt(refusal, () => action());
                expect(isNotFound(outcome), `${name} with ${refusal.name}`).toBe(true);
                expect(snapshot(), `${name} with ${refusal.name}`).toEqual(before);
            }
        });
    }

    it('lets the probe write once every check passes, so a write would show', async () => {
        const { probeWrite } = await import('../test/fixtures/curatorProbeAction');
        const before = snapshot();
        const outcome = await attempt({ name: 'allowed', env: { CURATION_ENABLED: 'true' }, headers: ALLOWED }, probeWrite);
        expect(outcome).toBe('resolved');
        expect(snapshot().data).toEqual({ ...before.data, 'curation/probe.json': '{}\n' });
    });
});

describe('the curator pages, rendered with the boundary failing', () => {
    it.each(REFUSALS.filter((refusal) => !refusal.name.includes('Origin')).map((refusal) => [refusal.name, refusal] as const))(
        '/curation 404s with %s and reads nothing',
        async (_, refusal) => {
            const { default: CurationPage } = await import('../app/curation/page');
            const before = snapshot();
            const outcome = await attempt({ ...refusal, headers: { host: refusal.headers.host ?? '' } }, () => CurationPage());
            expect(isNotFound(outcome)).toBe(true);
            expect(snapshot()).toEqual(before);
        },
    );

    it('/curation checks a request carrying Next-Action as a mutation', async () => {
        const { default: CurationPage } = await import('../app/curation/page');
        const outcome = await attempt({ name: 'action without Origin', env: { CURATION_ENABLED: 'true' }, headers: { host: CURATOR_HOST, 'next-action': ALLOWED['next-action'] } }, () =>
            CurationPage(),
        );
        expect(isNotFound(outcome)).toBe(true);
    });

    it('/curation renders on an allowed Host with the flag on', async () => {
        const { default: CurationPage } = await import('../app/curation/page');
        const outcome = await attempt({ name: 'allowed', env: { CURATION_ENABLED: 'true' }, headers: { host: CURATOR_HOST } }, () => CurationPage());
        expect(outcome).toBe('resolved');
    });
});
