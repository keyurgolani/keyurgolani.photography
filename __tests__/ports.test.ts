// @vitest-environment node
import net from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { EPHEMERAL_FLOOR, freePort, retryOnAddrInUse } from '../test/helpers/ports';

// The test servers' ports (#138's Themes flake: `listen EADDRINUSE 127.0.0.1:45683`). listen(0) picks from the
// kernel's ephemeral range, which every outgoing connection the browser and the readiness probes make draws its
// local port from too, and a probe that closes before the server binds leaves the port to whoever asks next.

const held: net.Server[] = [];

async function hold(port: number): Promise<void> {
    const server = net.createServer();
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    held.push(server);
}

afterEach(async () => {
    await Promise.all(held.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe('freePort', () => {
    it('picks below the ephemeral range, where no outgoing connection takes its local port', async () => {
        for (let i = 0; i < 20; i++) expect(await freePort()).toBeLessThan(EPHEMERAL_FLOOR);
    });

    it('never hands out the same port twice in one process, even to calls made at once', async () => {
        const ports = await Promise.all(Array.from({ length: 40 }, () => freePort()));
        expect(new Set(ports).size).toBe(ports.length);
    });

    it('hands out a port nothing listens on', async () => {
        const port = await freePort();
        await expect(hold(port)).resolves.toBeUndefined();
    });
});

describe('retryOnAddrInUse', () => {
    const inUse = () => Object.assign(new Error('listen EADDRINUSE: address already in use'), { code: 'EADDRINUSE' });

    it('starts again on a fresh port when the start finds its port taken', async () => {
        const tried: number[] = [];
        const started = await retryOnAddrInUse(async (port) => {
            tried.push(port);
            if (tried.length < 3) throw inUse();
            return `on ${port}`;
        });
        expect(tried).toHaveLength(3);
        expect(new Set(tried).size).toBe(3);
        expect(started).toBe(`on ${tried[2]}`);
    });

    it('also knows the collision from a server whose output says so', async () => {
        let calls = 0;
        await retryOnAddrInUse(async (port) => {
            calls++;
            if (calls === 1) throw new Error(`./tree on ${port} never answered 200 on /:\nError: listen EADDRINUSE: address already in use 127.0.0.1:${port}`);
            return port;
        });
        expect(calls).toBe(2);
    });

    it('passes any other failure straight on, untried again', async () => {
        let calls = 0;
        await expect(
            retryOnAddrInUse(async () => {
                calls++;
                throw new Error('never answered 503');
            }),
        ).rejects.toThrow('never answered 503');
        expect(calls).toBe(1);
    });

    it('gives up after a few collisions, with the last one', async () => {
        let calls = 0;
        await expect(
            retryOnAddrInUse(async () => {
                calls++;
                throw inUse();
            }),
        ).rejects.toThrow('EADDRINUSE');
        expect(calls).toBe(3);
    });
});
