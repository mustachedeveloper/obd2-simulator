import {createServer, type Server, type Socket} from 'node:net';
import {SimulatorEngine} from '../core/SimulatorEngine';

// Impersonates a WiFi ELM327 adapter: any OBD app that can talk to a
// network adapter (typically 192.168.0.10:35000) can connect to this server
// and see a live fake vehicle. Each client gets its own engine instance —
// its own vehicle — from the factory. Responses honor the engine's latency
// model and are written strictly in command order.

export interface TcpServerOptions {
    port?: number;
    // Bind address. The default exposes the fake adapter on every interface,
    // which is the point of impersonating a WiFi dongle — pass '127.0.0.1'
    // to keep it local.
    host?: string;
    // Called per connection; return the engine that backs this client.
    engineFactory?: () => SimulatorEngine;
    // Multiplies every simulated latency (0 → answer immediately).
    latencyScale?: number;
    // Longest command line accepted before the input buffer is discarded and
    // '?' printed — a client that never sends a carriage return cannot grow
    // memory without bound.
    maxLineLength?: number;
    onListening?: (port: number) => void;
    onConnection?: (remote: string) => void;
    // Server-level failures (EADDRINUSE, EACCES, ...). Without a handler
    // Node's default applies: the 'error' event throws.
    onError?: (error: Error) => void;
    // Per-client socket errors (ECONNRESET, ...); the socket is destroyed
    // either way.
    onClientError?: (remote: string, error: Error) => void;
}

const DEFAULT_PORT = 35000;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_MAX_LINE_LENGTH = 512;
const PROMPT = '\r\n>';
const LINE_END = /[\r\n]/;

const remoteOf = (socket: Socket): string => `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? '?'}`;

// One client: splits the byte stream into command lines and answers them
// through a serial timer chain, like a single-threaded adapter.
function serveClient(socket: Socket, engine: SimulatorEngine, options: Required<Pick<TcpServerOptions, 'latencyScale' | 'maxLineLength'>>): void {
    let buffer = '';
    let tail: Promise<void> = Promise.resolve();
    const timers = new Set<ReturnType<typeof setTimeout>>();

    const reply = (response: string, delayMs: number) => {
        tail = tail.then(
            () =>
                new Promise<void>((resolve) => {
                    const timer = setTimeout(() => {
                        timers.delete(timer);
                        if (!socket.destroyed) socket.write(`${response}${PROMPT}`);
                        resolve();
                    }, delayMs);
                    timers.add(timer);
                }),
        );
    };

    socket.on('data', (data) => {
        buffer += data.toString('ascii');
        // Real adapters execute on carriage return; empty lines repeat the
        // last command on hardware — here they are just skipped.
        let newline = buffer.search(LINE_END);
        while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line.length > options.maxLineLength) reply('?', 0);
            else if (line.length > 0) {
                const result = engine.execute(line);
                reply(result.response, Math.round(result.latency.totalMs * options.latencyScale));
            }
            newline = buffer.search(LINE_END);
        }
        if (buffer.length > options.maxLineLength) {
            buffer = '';
            reply('?', 0);
        }
    });
    socket.on('close', () => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
    });
}

const MAX_PORT = 65535;

// Options are caller-controlled, but a wrong value here fails in confusing
// ways (every command answered '?', or a RangeError from deep inside
// net.Server.listen), so they are checked up front.
function validateOptions(options: TcpServerOptions): Required<Pick<TcpServerOptions, 'port' | 'host' | 'latencyScale' | 'maxLineLength'>> {
    const port = options.port ?? DEFAULT_PORT;
    const latencyScale = options.latencyScale ?? 1;
    const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
    if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) throw new Error(`port must be an integer in 0-${MAX_PORT}, got ${port}`);
    if (!Number.isFinite(latencyScale) || latencyScale < 0) throw new Error(`latencyScale must be >= 0, got ${latencyScale}`);
    if (!Number.isInteger(maxLineLength) || maxLineLength < 1) throw new Error(`maxLineLength must be a positive integer, got ${maxLineLength}`);
    return {port, host: options.host ?? DEFAULT_HOST, latencyScale, maxLineLength};
}

export function createTcpServer(options: TcpServerOptions = {}): Server {
    const engineFactory = options.engineFactory ?? (() => new SimulatorEngine());
    const {port, host, latencyScale, maxLineLength} = validateOptions(options);
    const clientOptions = {latencyScale, maxLineLength};

    const server = createServer((socket) => {
        const remote = remoteOf(socket);
        options.onConnection?.(remote);
        socket.on('error', (error) => {
            options.onClientError?.(remote, error);
            socket.destroy();
        });
        serveClient(socket, engineFactory(), clientOptions);
    });
    if (options.onError) server.on('error', options.onError);

    server.listen(port, host, () => options.onListening?.(port));
    return server;
}
