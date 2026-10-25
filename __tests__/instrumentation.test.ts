// @vitest-environment node
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
