import {createServer, type Server} from 'node:net';
import {SimulatorEngine} from '../core/SimulatorEngine';

// Impersonates a WiFi ELM327 adapter: any OBD app that can talk to a
// network adapter (typically 192.168.0.10:35000) can connect to this server
// and see a live fake vehicle. Each client gets its own engine instance —
// its own vehicle — from the factory.

export interface TcpServerOptions {
    port?: number;
    host?: string;
    // Called per connection; return the engine that backs this client.
    engineFactory?: () => SimulatorEngine;
    onListening?: (port: number) => void;
    onConnection?: (remote: string) => void;
}

export function createTcpServer(options: TcpServerOptions = {}): Server {
    const engineFactory = options.engineFactory ?? (() => new SimulatorEngine());
    const port = options.port ?? 35000;
    const host = options.host ?? '0.0.0.0';

    const server = createServer((socket) => {
        const engine = engineFactory();
        options.onConnection?.(`${socket.remoteAddress ?? '?'}:${socket.remotePort ?? '?'}`);
        let buffer = '';
        socket.on('data', (data) => {
            buffer += data.toString('ascii');
            // Real adapters execute on carriage return; empty lines repeat
            // the last command on hardware — here they are just skipped.
            let newline = buffer.search(/[\r\n]/);
            while (newline >= 0) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (line.length > 0) {
                    socket.write(`${engine.handleCommand(line)}\r\n>`);
                }
                newline = buffer.search(/[\r\n]/);
            }
        });
        socket.on('error', () => socket.destroy());
    });

    server.listen(port, host, () => options.onListening?.(port));
    return server;
}
