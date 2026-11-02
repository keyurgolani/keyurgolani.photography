import net from 'node:net';

// Ports for the servers the tests start on 127.0.0.1. listen(0) would pick from the kernel's ephemeral range
// (32768 up on Linux, 49152 up on macOS), where every outgoing connection the browser and the readiness probes
// make takes its local port too, so a port probed free there can be taken before the server binds it (#138's
// Themes flake). These come from below it instead, and never twice in one process.

/** The lowest port either kernel hands out on its own. */
export const EPHEMERAL_FLOOR = 32_768;
const FLOOR = 20_000;

/** Every port this process has handed out, so two servers it starts at once never get the same one. */
const handedOut = new Set<number>();

function listens(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
}

/** A port below the ephemeral range that nothing on 127.0.0.1 listens on now, and that this process hasn't handed out. */
export async function freePort(): Promise<number> {
    for (let attempt = 0; attempt < 200; attempt++) {
        const port = FLOOR + Math.floor(Math.random() * (EPHEMERAL_FLOOR - FLOOR));
        if (handedOut.has(port)) continue;
        // Taken before the probe, so a second call made meanwhile can't pick it too.
        handedOut.add(port);
        if (await listens(port)) return port;
    }
    throw new Error(`No free port between ${FLOOR} and ${EPHEMERAL_FLOOR} after 200 tries`);
}

const ADDR_IN_USE = /EADDRINUSE/;
const TRIES = 3;

/**
 * Runs `start` on a free port, and again on a fresh one when it fails because the port was taken meanwhile, which
 * a server's error or its captured output says with EADDRINUSE. Any other failure goes straight on. A pinned port
 * isn't this helper's: a caller with one starts on it directly.
 */
export async function retryOnAddrInUse<T>(start: (port: number) => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 0; attempt < TRIES; attempt++) {
        try {
            return await start(await freePort());
        } catch (error) {
            const code = (error as { code?: unknown }).code;
            if (code !== 'EADDRINUSE' && !ADDR_IN_USE.test(String((error as Error)?.message ?? error))) throw error;
            last = error;
        }
    }
    throw last;
}
