import http from 'node:http';
import type net from 'node:net';

/**
 * A plain-http forward proxy on 127.0.0.1 that hands every request to one
 * server on 127.0.0.1, with the `Host` the browser sent. A test browser set
 * to use it can open `http://192.168.86.250:3001` as a device on the owner's
 * LAN would, while the curator under test still listens on loopback only.
 * It forwards nothing else: no CONNECT, and no other destination.
 */

export interface ForwardProxy {
    /** For Playwright's `proxy.server`. */
    server: string;
    stop: () => Promise<void>;
}

/** Hop-by-hop headers a proxy drops. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export async function startForwardProxy(targetPort: number): Promise<ForwardProxy> {
    const sockets = new Set<net.Socket>();
    const proxy = http.createServer((request, response) => {
        let path: string;
        try {
            const url = new URL(request.url ?? '');
            path = `${url.pathname}${url.search}`;
        } catch {
            response.writeHead(400).end();
            return;
        }
        const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !HOP_BY_HOP.has(name)));
        const upstream = http.request({ host: '127.0.0.1', port: targetPort, method: request.method, path, headers }, (answer) => {
            response.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.pipe(response);
        });
        upstream.on('error', () => response.destroy());
        request.pipe(upstream);
    });
    proxy.on('connect', (_request, socket: net.Socket) => socket.destroy());
    proxy.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
        proxy.once('error', reject);
        proxy.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = proxy.address() as net.AddressInfo;
    return {
        server: `http://127.0.0.1:${port}`,
        stop: () =>
            new Promise<void>((resolve) => {
                for (const socket of sockets) socket.destroy();
                proxy.close(() => resolve());
            }),
    };
}
