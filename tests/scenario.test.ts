import {describe, expect, it} from 'vitest';
import {MemoryLink, SimulatorEngine, VLINKER_ADAPTER} from '../src/index';

// The scenario API: everything a test needs to steer the fake vehicle and
// adapter while an app is talking to it.

const engineAt = (ms: number, extra: ConstructorParameters<typeof SimulatorEngine>[0] = {}) => {
    let current = 0;
    const engine = new SimulatorEngine({now: () => current, seed: 7, ...extra});
    current = ms;
    engine.handleCommand('ATE0');
    return engine;
};

const rpmOf = (engine: SimulatorEngine): number => Number.parseInt(engine.handleCommand('010C').slice(4), 16) / 4;
const coolantOf = (engine: SimulatorEngine): number => Number.parseInt(engine.handleCommand('0105').slice(4), 16) - 40;

describe('value overrides', () => {
    it('pins a PID to a physical value until cleared', () => {
        const engine = engineAt(60_000);
        engine.override(0x05, 120);
        expect(coolantOf(engine)).toBe(120);
        expect(engine.overrides).toEqual({5: 120});
        engine.clearOverride(0x05);
        expect(coolantOf(engine)).toBeLessThan(100);
        expect(engine.overrides).toEqual({});
    });

    it('makes a PID report NO DATA with null, and clears everything at once', () => {
        const engine = engineAt(0);
        engine.override(0x0c, null);
        engine.override(0x0d, 42);
        expect(engine.handleCommand('010C')).toBe('NO DATA');
        expect(engine.handleCommand('010D')).toBe('410D2A');
        engine.clearOverrides();
        expect(engine.handleCommand('010C')).toMatch(/^410C/);
    });

    it('rejects values that cannot be encoded', () => {
        const engine = engineAt(0);
        expect(() => engine.override(0x04, Number.NaN)).toThrow(/finite number or null/);
        expect(() => engine.override(0x04, Number.POSITIVE_INFINITY)).toThrow(/finite number or null/);
        expect(() => engine.override(-1, 1)).toThrow(/PID/);
        expect(engine.handleCommand('0104')).toMatch(/^4104[0-9A-F]{2}$/);
    });

    it('is captured by the freeze frame like any other value', () => {
        const engine = engineAt(0);
        engine.override(0x0d, 88);
        engine.injectDtc('P0301');
        expect(engine.handleCommand('020D00')).toBe('420D0058');
    });
});

describe('ignition states', () => {
    it('sleeps every ECU with the key off', () => {
        const engine = engineAt(0);
        engine.setIgnition('off');
        expect(engine.ignition).toBe('off');
        expect(engine.handleCommand('010C')).toBe('NO DATA');
        expect(engine.handleCommand('0902')).toBe('NO DATA');
        expect(engine.handleCommand('03')).toBe('NO DATA');
        expect(engine.handleCommand('ATIGN')).toBe('OFF');
        expect(Number.parseFloat(engine.handleCommand('ATRV'))).toBeLessThan(12.6);
        expect(engine.handleCommand('ATI')).toBe('ELM327 v1.5'); // the adapter itself stays awake
    });

    it('answers with a stopped engine when the key is on', () => {
        const engine = engineAt(60_000);
        engine.setIgnition('key-on');
        expect(rpmOf(engine)).toBe(0);
        expect(engine.handleCommand('010D')).toBe('410D00');
        expect(engine.handleCommand('011F')).toBe('411F0000'); // run time
        expect(engine.handleCommand('ATIGN')).toBe('ON');
        expect(Number.parseFloat(engine.handleCommand('ATRV'))).toBeLessThan(13);
        expect(engine.handleCommand('0902')).toMatch(/^014/);
    });

    it('reports UNABLE TO CONNECT for a searching adapter with the key off', () => {
        const engine = engineAt(0, {adapter: VLINKER_ADAPTER});
        engine.handleCommand('ATS0');
        engine.setIgnition('off');
        expect(engine.handleCommand('0100')).toBe('SEARCHING...\rUNABLE TO CONNECT');
        engine.setIgnition('running');
        expect(engine.handleCommand('0100')).toMatch(/^SEARCHING\.\.\.\r4100/);
        expect(rpmOf(engine)).toBeGreaterThan(500);
    });
});

describe('DTC API symmetry', () => {
    it('exposes every list and removes or clears codes directly', () => {
        const engine = engineAt(0);
        engine.injectDtc('P0301');
        engine.injectDtc('P0171', 'pending');
        engine.injectDtc('P0420', 'permanent');
        expect(engine.pendingDtcs).toEqual(['P0171']);
        expect(engine.permanentDtcs).toEqual(['P0420']);
        engine.removeDtc('p0420');
        expect(engine.permanentDtcs).toEqual([]);
        expect(engine.handleCommand('0A')).toBe('4A00');
        engine.clearDtcs();
        expect(engine.storedDtcs).toEqual([]);
        expect(engine.pendingDtcs).toEqual([]);
        expect(engine.handleCommand('020200')).toBe('4202000000');
    });

    it('rejects malformed codes on removal too', () => {
        expect(() => engineAt(0).removeDtc('nope')).toThrow(/invalid DTC/);
    });
});

describe('adapter fault injection', () => {
    it('answers the next OBD requests with the adapter error, AT commands untouched', () => {
        const engine = engineAt(0);
        engine.failNext('BUFFER FULL', 2);
        expect(engine.handleCommand('ATRV')).toMatch(/V$/);
        expect(engine.handleCommand('010C')).toBe('BUFFER FULL');
        expect(engine.execute('010D').latency.waitMs).toBe(0);
        expect(engine.handleCommand('010D')).toMatch(/^410D/);
        expect(engine.pendingFaults).toEqual([]);
    });

    it('bounds the queue so a typo cannot allocate the moon', () => {
        const engine = engineAt(0);
        expect(() => engine.failNext('STOPPED', 5_000_000_000)).toThrow(/count/);
        expect(() => engine.failNext('STOPPED', 1001)).toThrow(/count/);
        engine.failNext('STOPPED', 0);
        expect(engine.pendingFaults).toEqual([]);
    });

    it('queues different faults in order and can be cancelled', () => {
        const engine = engineAt(0);
        engine.failNext('CAN ERROR');
        engine.failNext('STOPPED');
        expect(engine.pendingFaults).toEqual(['CAN ERROR', 'STOPPED']);
        expect(engine.handleCommand('010C')).toBe('CAN ERROR');
        engine.clearFaults();
        expect(engine.handleCommand('010C')).toMatch(/^410C/);
    });
});

describe('adapter reset and command events', () => {
    it('power-cycles the adapter: settings back to defaults, banner printed unprompted', () => {
        const engine = engineAt(0);
        engine.handleCommand('ATH1');
        expect(engine.resetAdapter()).toBe('\rELM327 v1.5\r\r>');
        expect(engine.linkState).toMatchObject({echo: true, headers: false, searched: false});
    });

    it('notifies listeners of every command with its result', () => {
        const engine = engineAt(0);
        const seen: string[] = [];
        const off = engine.onCommand((result) => seen.push(`${result.command}=${result.response}`));
        engine.handleCommand('ATRV');
        engine.handleCommand('03');
        off();
        engine.handleCommand('07');
        expect(seen).toEqual([expect.stringMatching(/^ATRV=\d+\.\dV$/), '03=4300']);
    });
});

describe('snapshot / restore', () => {
    it('rejects a bad snapshot without touching the engine', () => {
        const engine = engineAt(0);
        engine.handleCommand('ATH1');
        engine.injectDtc('P0301');
        const good = engine.snapshot();
        const bad = {...good, link: {...good.link, headers: false}, pendingDtcs: ['NOT-A-DTC']};
        expect(() => engine.restore(bad)).toThrow(/invalid DTC/);
        expect(engine.linkState.headers).toBe(true);
        expect(engine.storedDtcs).toEqual(['P0301']);
        expect(() => engine.restore({...good, overrides: 'nope' as never})).toThrow(/overrides/);
        expect(() => engine.restore({...good, ignition: 'sideways' as never})).toThrow(/ignition/);
        expect(() => engine.restore({...good, pendingFaults: ['KABOOM' as never]})).toThrow(/fault/);
        expect(() => engine.restore({...good, link: null as never})).toThrow(/link/);
        expect(engine.snapshot()).toEqual(good);
    });

    it('round-trips the whole mutable state through JSON', () => {
        const engine = engineAt(0);
        engine.handleCommand('ATH1');
        engine.handleCommand('ATST19');
        engine.injectDtc('P0301');
        engine.override(0x05, 120);
        engine.setIgnition('key-on');
        engine.failNext('STOPPED');
        const snapshot = JSON.parse(JSON.stringify(engine.snapshot()));

        const other = engineAt(0);
        other.restore(snapshot);
        expect(other.linkState).toMatchObject({headers: true, timeoutHex: '19', echo: false});
        expect(other.storedDtcs).toEqual(['P0301']);
        expect(other.overrides).toEqual({5: 120});
        expect(other.ignition).toBe('key-on');
        expect(other.handleCommand('010C')).toBe('STOPPED');
        expect(other.handleCommand('020200')).toMatch(/^7E8/); // headers on, freeze frame restored
        expect(other.handleCommand('0105')).toMatch(/^7E80341\s?05A0/);
    });
});

describe('MemoryLink fault injection', () => {
    const collect = (link: MemoryLink, ms: number) =>
        new Promise<string>((resolve) => {
            let buffer = '';
            link.onData((chunk) => (buffer += chunk));
            setTimeout(() => resolve(buffer), ms);
        });

    it('drops the prompt, truncates or garbles the next responses on request', async () => {
        const link = new MemoryLink(new SimulatorEngine({now: () => 0}), {
            connectDelayMs: 1,
            responseDelayMs: 1,
            jitterMs: 0,
            includeWaitWindow: false,
        });
        await link.connect();
        await link.write('ATE0');
        link.corruptNext('drop-prompt');
        link.corruptNext('truncate');
        link.corruptNext('garbage');
        const pending = collect(link, 40);
        await link.write('ATI');
        await link.write('ATI');
        await link.write('ATI');
        await link.write('ATI');
        const received = await pending;
        expect(received).toBe('ATE0\rOK\r\r>' + 'ELM327 v1.5\r\r' + 'ELM327 ' + 'ÿÿELM327 v1.5\r\r>' + 'ELM327 v1.5\r\r>');
        await link.disconnect();
    });

    it('bounds the corruption queue', () => {
        const link = new MemoryLink(new SimulatorEngine({now: () => 0}));
        expect(() => link.corruptNext('garbage', 1001)).toThrow(/count/);
        link.corruptNext('garbage', 2);
        expect(link.pendingCorruptions).toEqual(['garbage', 'garbage']);
    });

    it('emits the banner unprompted on a simulated adapter reset', async () => {
        const link = new MemoryLink(new SimulatorEngine({now: () => 0}), {connectDelayMs: 1, responseDelayMs: 1, jitterMs: 0});
        await link.connect();
        await link.write('ATE0');
        const pending = collect(link, 20);
        link.simulateAdapterReset();
        expect(await pending).toBe('ATE0\rOK\r\r>\rELM327 v1.5\r\r>');
        expect(link.currentEngine.linkState.echo).toBe(true);
        await link.disconnect();
    });
});
