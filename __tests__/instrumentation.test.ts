// @vitest-environment node
import { once } from 'node:events';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { register } from '../instrumentation';

// The startup check: with CURATION_ENABLED=true, a server told to listen
// beyond loopback stops with a message naming the setting, never its value.

let exit: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('NEXT_PHASE', '');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CURATOR_TUNNEL_PORT', '');
    vi.stubEnv('CURATION_BIND_SCOPE', '');
    exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('register() with the curator on', () => {
    it.each([
        ['every interface', '0.0.0.0', 'HOSTNAME is not'],
        ['a LAN address', '198.51.100.7', 'HOSTNAME is not'],
        ['no address', '', 'HOSTNAME is unset'],
    ])('stops the server told to listen on %s', async (_, hostname, reason) => {
        vi.stubEnv('CURATION_ENABLED', 'true');
        vi.stubEnv('HOSTNAME', hostname);
        await register();
        expect(exit).toHaveBeenCalledWith(1);
        const [message] = error.mock.calls[0] as [string];
        expect(message).toContain('CURATION_ENABLED is true');
        expect(message).toContain(reason);
        expect(message).toContain('docs/curator.md');
        if (hostname) expect(message).not.toContain(hostname);
    });

    it('stops on a CURATOR_TUNNEL_PORT that is no port', async () => {
        vi.stubEnv('CURATION_ENABLED', 'true');
        vi.stubEnv('HOSTNAME', '127.0.0.1');
        vi.stubEnv('CURATOR_TUNNEL_PORT', 'tunnel');
        await register();
        expect(exit).toHaveBeenCalledWith(1);
        expect(error.mock.calls[0][0]).toContain('CURATOR_TUNNEL_PORT');
    });

    it.each(['127.0.0.1', '::1', 'localhost'])('starts on %s', async (hostname) => {
        vi.stubEnv('CURATION_ENABLED', 'true');
        vi.stubEnv('HOSTNAME', hostname);
        await register();
        expect(exit).not.toHaveBeenCalled();
    });

    it("keeps running without its secret files, and says every path answers 503, naming the setting and no path's contents", async () => {
        vi.stubEnv('CURATION_ENABLED', 'true');
        vi.stubEnv('HOSTNAME', '127.0.0.1');
        vi.stubEnv('CURATOR_PASSPHRASE_HASH_FILE', '/nonexistent/curator-passphrase.hash');
        await register();
        expect(exit).not.toHaveBeenCalled();
        const [message] = error.mock.calls.at(-1) as [string];
        expect(message).toContain('CURATOR_PASSPHRASE_HASH_FILE');
        expect(message).toContain('503');
    });
});

describe('register() under next dev', () => {
    beforeEach(() => {
        vi.stubEnv('CURATION_ENABLED', 'true');
        vi.stubEnv('__NEXT_DEV_SERVER', '1');
        vi.stubEnv('NEXT_PRIVATE_WORKER', '1');
    });

    it('starts when the server it finds listens on loopback, whatever HOSTNAME says', async () => {
        vi.stubEnv('HOSTNAME', '');
        const server = http.createServer();
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        try {
            await register();
            expect(exit).not.toHaveBeenCalled();
        } finally {
            server.close();
            await once(server, 'close');
        }
    });

    it('stops when it finds no listening socket to check', async () => {
        vi.stubEnv('HOSTNAME', '127.0.0.1');
        await register();
        expect(exit).toHaveBeenCalledWith(1);
        expect(error.mock.calls[0][0]).toContain("the dev server's listening address can't be read");
    });
});

describe('register() with the curator off', () => {
    it.each(['0.0.0.0', ''])('leaves a server on HOSTNAME=%j alone, as web runs in its container', async (hostname) => {
        vi.stubEnv('CURATION_ENABLED', 'false');
        vi.stubEnv('HOSTNAME', hostname);
        await register();
        expect(exit).not.toHaveBeenCalled();
    });

    it('skips the build', async () => {
        vi.stubEnv('CURATION_ENABLED', 'true');
        vi.stubEnv('HOSTNAME', '0.0.0.0');
        vi.stubEnv('NEXT_PHASE', 'phase-production-build');
        await register();
        expect(exit).not.toHaveBeenCalled();
    });
});
