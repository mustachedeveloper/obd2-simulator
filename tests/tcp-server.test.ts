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
});
