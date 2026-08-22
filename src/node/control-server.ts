import {createServer, type Server} from 'node:net';
import type {SimulatorEngine} from '../core/SimulatorEngine';
import {applyControlCommand} from './control';

// Second TCP port next to the fake adapter: `nc host 35001`, then type
// 'dtc P0301' or 'ignition off' to steer every connected vehicle while the
// app under test keeps polling. Newline-terminated lines in, one reply
// line out.

export interface ControlServerOptions {
    port?: number;
    host?: string;
    /**
     * The engines currently serving clients.
     */
    engines: () => readonly SimulatorEngine[];
    onListening?: (port: number) => void;
    onError?: (error: Error) => void;
    onClientError?: (remote: string, error: Error) => void;
    /**
     * Every processed line with its reply — e.g. to replay the successful
     * ones on engines created later, so the scenario outlives reconnects.
     */
    onApplied?: (line: string, reply: string) => void;
}

const DEFAULT_PORT = 35001;
const DEFAULT_HOST = '127.0.0.1';
const MAX_LINE_LENGTH = 256;

export function createControlServer(options: ControlServerOptions): Server {
    const port = options.port ?? DEFAULT_PORT;
    const host = options.host ?? DEFAULT_HOST;
    const server = createServer((socket) => {
        const remote = `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? '?'}`;
        let buffer = '';
        socket.on('data', (data) => {
            buffer += data.toString('utf8');
            let newline = buffer.indexOf('\n');
            while (newline >= 0) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (line.length > 0) {
                    const reply = applyControlCommand(line, options.engines());
                    options.onApplied?.(line, reply);
                    if (!socket.destroyed) socket.write(`${reply}\n`);
                }
                newline = buffer.indexOf('\n');
            }
            if (buffer.length > MAX_LINE_LENGTH) {
                buffer = '';
                if (!socket.destroyed) socket.write('error line too long\n');
            }
        });
        socket.on('error', (error) => {
            options.onClientError?.(remote, error);
            socket.destroy();
        });
    });
    if (options.onError) server.on('error', options.onError);
    server.listen(port, host, () => options.onListening?.(port));
    return server;
}
