import {createConnection} from 'node:net';
import {describe, expect, it} from 'vitest';
import {CLONE_V21_ADAPTER, SimulatorEngine} from '../src/index';
import {createTcpServer} from '../src/node/index';

const listen = (options: Parameters<typeof createTcpServer>[0]) =>
    new Promise<{server: ReturnType<typeof createTcpServer>; port: number}>((resolve) => {
        const server = createTcpServer({...options, port: 0, host: '127.0.0.1', onListening: () => {
            const address = server.address();
            resolve({server, port: typeof address === 'object' && address ? address.port : 0});
        }});
    });

describe('TCP server', () => {
    it('answers in order with prompt framing and the persona latency', async () => {
        const {server, port} = await listen({
            engineFactory: () => new SimulatorEngine({now: () => 0, adapter: CLONE_V21_ADAPTER}),
            latencyScale: 0.1,
        });
        const socket = createConnection({port, host: '127.0.0.1'});
        let received = '';
        socket.on('data', (chunk) => (received += chunk.toString('ascii')));
        await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
        socket.write('ATZ\rATE0\rATST19\r010C 1\rATRV\r');
        await new Promise((resolve) => setTimeout(resolve, 400));
        const prompts = received.split('\r\n>').filter(Boolean);
        expect(prompts[0]).toBe('ATZ\rELM327 v2.1');
        expect(prompts[1]).toBe('ATE0\rOK');
        expect(prompts[3].split('\r')).toHaveLength(2); // clone: both ECUs despite the hint
        expect(prompts[4]).toMatch(/V$/);
        socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('reports a listen failure through onError instead of crashing', async () => {
        const {server, port} = await listen({});
        const error = await new Promise<Error>((resolve) => {
            createTcpServer({port, host: '127.0.0.1', onError: resolve});
        });
        expect((error as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('discards an oversized line, answers ? and keeps serving', async () => {
        const {server, port} = await listen({
            engineFactory: () => new SimulatorEngine({now: () => 0}),
            latencyScale: 0,
            maxLineLength: 32,
        });
        const socket = createConnection({port, host: '127.0.0.1'});
        let received = '';
        socket.on('data', (chunk) => (received += chunk.toString('ascii')));
        await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
        socket.write('A'.repeat(100));
        socket.write('\rATE0\rATI\r');
        await new Promise((resolve) => setTimeout(resolve, 100));
        const prompts = received.split('\r\n>').filter(Boolean);
        expect(prompts[0]).toBe('?');
        expect(prompts[1]).toBe('ATE0\rOK');
        expect(prompts[2]).toBe('ELM327 v1.5');
        socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('reassembles a command that arrives in pieces', async () => {
        const {server, port} = await listen({engineFactory: () => new SimulatorEngine({now: () => 0}), latencyScale: 0});
        const socket = createConnection({port, host: '127.0.0.1'});
        let received = '';
        socket.on('data', (chunk) => (received += chunk.toString('ascii')));
        await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
        for (const piece of ['AT', 'E0\r01', '0C', '\r']) {
            socket.write(piece);
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        const prompts = received.split('\r\n>').filter(Boolean);
        expect(prompts).toEqual(['ATE0\rOK', expect.stringMatching(/^410C[0-9A-F]{4}$/)]);
        socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('reports client socket errors through onClientError', async () => {
        const errors: string[] = [];
        const {server, port} = await listen({
            engineFactory: () => new SimulatorEngine({now: () => 0}),
            onClientError: (remote, error) => errors.push(`${remote.split(':')[0]} ${(error as NodeJS.ErrnoException).code}`),
        });
        const socket = createConnection({port, host: '127.0.0.1'});
        await new Promise<void>((resolve) => socket.on('connect', () => resolve()));
        await new Promise((resolve) => setTimeout(resolve, 20)); // let the server accept before the RST
        socket.write('010C\r');
        socket.resetAndDestroy(); // RST instead of FIN → ECONNRESET on the server side
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(errors).toEqual(['127.0.0.1 ECONNRESET']);
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('rejects nonsensical server options up front', () => {
        expect(() => createTcpServer({maxLineLength: 0})).toThrow(/maxLineLength/);
        expect(() => createTcpServer({latencyScale: -1})).toThrow(/latencyScale/);
    });
});
