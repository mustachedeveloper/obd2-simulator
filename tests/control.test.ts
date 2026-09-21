import {createConnection} from 'node:net';
import {describe, expect, it} from 'vitest';
import {SimulatorEngine} from '../src/index';
import {applyControlCommand, createControlServer, createTcpServer} from '../src/node/index';
import {SYNTHETIC_GASOLINE_PROFILE} from './helpers/synthetic';

const engines = () => [
    new SimulatorEngine({now: () => 0, profile: SYNTHETIC_GASOLINE_PROFILE}),
    new SimulatorEngine({now: () => 0, profile: SYNTHETIC_GASOLINE_PROFILE}),
];

describe('control commands', () => {
    it('steers every live engine at once', () => {
        const live = engines();
        for (const engine of live) engine.handleCommand('ATE0');
        expect(applyControlCommand('dtc P0301', live)).toBe('ok 2 engine(s): injected P0301 (stored)');
        expect(applyControlCommand('dtc p0171 pending', live)).toBe('ok 2 engine(s): injected P0171 (pending)');
        expect(live.map((engine) => engine.handleCommand('03'))).toEqual(['43010301', '43010301']);
        expect(applyControlCommand('set 05 120', live)).toBe('ok 2 engine(s): PID 05 = 120');
        expect(live[0]?.handleCommand('0105')).toBe('4105A0');
        expect(applyControlCommand('set 0C null', live)).toBe('ok 2 engine(s): PID 0C = NO DATA');
        expect(applyControlCommand('ignition key-on', live)).toBe('ok 2 engine(s): ignition key-on');
        expect(applyControlCommand('fail BUFFER FULL 2', live)).toBe('ok 2 engine(s): next 2 request(s) → BUFFER FULL');
        expect(live[1]?.handleCommand('010D')).toBe('BUFFER FULL');
        expect(applyControlCommand('adapter clone', live)).toBe('ok 2 engine(s): adapter clone-v2.1');
        expect(applyControlCommand('clear dtcs', live)).toBe('ok 2 engine(s): DTCs cleared');
        expect(applyControlCommand('clear overrides', live)).toBe('ok 2 engine(s): overrides cleared');
        expect(applyControlCommand('clear faults', live)).toBe('ok 2 engine(s): faults cleared');
        expect(live[0]?.storedDtcs).toEqual([]);
    });

    it('reports status as JSON and explains mistakes', () => {
        const live = engines();
        live[0]?.injectDtc('P0420');
        const status = applyControlCommand('status', live);
        expect(status.startsWith('ok ')).toBe(true);
        expect(JSON.parse(status.slice(3))).toEqual([
            {
                ignition: 'running',
                adapter: 'default',
                storedDtcs: ['P0420'],
                pendingDtcs: [],
                permanentDtcs: [],
                overrides: {},
                pendingFaults: [],
            },
            {
                ignition: 'running',
                adapter: 'default',
                storedDtcs: [],
                pendingDtcs: [],
                permanentDtcs: [],
                overrides: {},
                pendingFaults: [],
            },
        ]);
        expect(applyControlCommand('dtc garbage', live)).toMatch(/^error invalid DTC "garbage"/);
        expect(applyControlCommand('set ZZ 1', live)).toMatch(/^error /);
        expect(applyControlCommand('ignition sideways', live)).toMatch(/^error ignition expects/);
        expect(applyControlCommand('fail NOPE', live)).toMatch(/^error fail expects/);
        expect(applyControlCommand('adapter nope', live)).toMatch(/^error adapter expects/);
        expect(applyControlCommand('dance', live)).toMatch(/^error unknown command "dance"/);
        expect(applyControlCommand('help', live)).toMatch(/^ok commands:/);
        expect(applyControlCommand('dtc P0301', [])).toBe('ok 0 engine(s): injected P0301 (stored)');
    });
});

describe('control server', () => {
    it('drives the engines behind a running TCP server over a second port', async () => {
        const live = new Set<SimulatorEngine>();
        const obd = createTcpServer({
            port: 0,
            host: '127.0.0.1',
            latencyScale: 0,
            engineFactory: () => new SimulatorEngine({now: () => 0, profile: SYNTHETIC_GASOLINE_PROFILE}),
            onEngine: (engine) => {
                live.add(engine);
                return () => live.delete(engine);
            },
        });
        await new Promise<void>((resolve) => obd.once('listening', () => resolve()));
        const applied: string[] = [];
        const control = createControlServer({
            port: 0,
            host: '127.0.0.1',
            engines: () => [...live],
            onApplied: (line, reply) => applied.push(`${line} → ${reply.slice(0, 2)}`),
        });
        await new Promise<void>((resolve) => control.once('listening', () => resolve()));
        const port = (address: ReturnType<typeof obd.address>) => (typeof address === 'object' && address ? address.port : 0);

        const app = createConnection({port: port(obd.address()), host: '127.0.0.1'});
        let appData = '';
        app.on('data', (chunk) => (appData += chunk.toString('ascii')));
        await new Promise<void>((resolve) => app.on('connect', () => resolve()));
        app.write('ATE0\r');
        await new Promise((resolve) => setTimeout(resolve, 30));

        const operator = createConnection({port: port(control.address()), host: '127.0.0.1'});
        let replies = '';
        operator.on('data', (chunk) => (replies += chunk.toString('utf8')));
        await new Promise<void>((resolve) => operator.on('connect', () => resolve()));
        operator.write('dtc P0301\nstatus\n');
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(replies.split('\n').filter(Boolean)[0]).toBe('ok 1 engine(s): injected P0301 (stored)');
        expect(replies).toContain('"storedDtcs":["P0301"]');
        expect(applied).toEqual(['dtc P0301 → ok', 'status → ok']);

        app.write('03\r');
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(appData).toContain('43010301\r\r>');

        app.destroy();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(live.size).toBe(0);
        operator.destroy();
        await Promise.all([obd, control].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    });
});
