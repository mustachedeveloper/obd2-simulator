import {describe, expect, it} from 'vitest';
import {
    ADAPTER_PRESETS,
    CLONE_OBDII_ADAPTER,
    CLONE_V21_ADAPTER,
    GASOLINE_PROFILE,
    MemoryLink,
    SimulatorEngine,
    VLINKER_ADAPTER,
    VLINKER_FD_ADAPTER,
    createSimulator,
} from '../src/index';
import type {AdapterPersona} from '../src/index';
import {applyControlCommand} from '../src/node/control';

// Behaviour read off the real-vehicle recordings (110 sessions, four
// adapters): the engine ECU's after-run phase, the vLinker's frame-counting
// response hint and the gear-only layout of PID A4.

const lines = (text: string) => text.split('\r').filter(Boolean);

function recordedCar(adapter: AdapterPersona = VLINKER_ADAPTER) {
    const clock = {ms: 60_000};
    const engine = createSimulator('default-gasoline', {now: () => clock.ms, seed: 7, adapter});
    for (const command of ['ATE0', 'ATL0', 'ATS0', 'ATST19', 'ATSP7']) engine.handleCommand(command);
    return {engine, clock};
}

describe('engine after-run phase', () => {
    it('rejects with 7F xx 22 from the engine ECU alone, then falls silent', () => {
        const {engine, clock} = recordedCar();
        engine.setIgnition('off', {afterRunMs: 12_000});
        expect(engine.ignition).toBe('off');
        expect(engine.handleCommand('010C 1')).toBe('7F0122');
        expect(engine.handleCommand('010C')).toBe('7F0122'); // the TCM is already asleep
        expect(engine.handleCommand('010C5E0D 1')).toBe('7F0122');
        expect(engine.handleCommand('03')).toBe('7F0322');
        expect(engine.handleCommand('07')).toBe('7F0722');
        expect(Number.parseFloat(engine.handleCommand('ATRV'))).toBeLessThan(12.6);
        clock.ms += 11_999;
        expect(engine.handleCommand('010C 1')).toBe('7F0122');
        clock.ms += 1;
        expect(engine.handleCommand('010C 1')).toBe('NO DATA');
        expect(engine.handleCommand('03')).toBe('NO DATA');
    });

    it('lets a searching adapter connect during the after-run, not after it', () => {
        const {engine, clock} = recordedCar();
        engine.setIgnition('off', {afterRunMs: 5_000});
        for (const command of ['ATZ', 'ATE0', 'ATS0', 'ATSP0']) engine.handleCommand(command);
        expect(engine.handleCommand('0100')).toBe('SEARCHING...\r7F0122');
        clock.ms += 5_000;
        for (const command of ['ATZ', 'ATE0', 'ATS0', 'ATSP0']) engine.handleCommand(command);
        expect(engine.handleCommand('0100')).toBe('SEARCHING...\rUNABLE TO CONNECT');
    });

    it('comes from the engine ECU only, whoever is addressed', () => {
        const {engine} = recordedCar();
        engine.setIgnition('off', {afterRunMs: 12_000});
        engine.handleCommand('ATH1');
        expect(engine.handleCommand('010C')).toMatch(/^18DAF101037F0122/);
        engine.handleCommand('ATCRA18DAF102'); // listening to the TCM alone
        expect(engine.handleCommand('010C')).toBe('NO DATA');
    });

    it('stays instant without the option and ends when the ignition changes again', () => {
        const {engine} = recordedCar();
        engine.setIgnition('off');
        expect(engine.handleCommand('010C 1')).toBe('NO DATA');
        engine.setIgnition('off', {afterRunMs: 60_000});
        engine.setIgnition('running');
        expect(engine.handleCommand('010C 1')).toMatch(/^410C/);
        engine.setIgnition('off', {afterRunMs: 60_000});
        engine.setIgnition('off');
        expect(engine.handleCommand('010C 1')).toBe('NO DATA');
    });

    it('validates the option and drops the phase on restore', () => {
        const {engine} = recordedCar();
        expect(() => engine.setIgnition('off', {afterRunMs: -1})).toThrow(/afterRunMs/);
        expect(() => engine.setIgnition('off', {afterRunMs: Number.NaN})).toThrow(/afterRunMs/);
        expect(() => engine.setIgnition('running', {afterRunMs: 1000})).toThrow(/afterRunMs/);
        engine.setIgnition('off', {afterRunMs: 60_000});
        engine.restore(engine.snapshot());
        expect(engine.handleCommand('010C 1')).toBe('NO DATA');
    });

    it('is reachable from the control channel', () => {
        const {engine, clock} = recordedCar();
        expect(applyControlCommand('ignition off 10', [engine])).toBe('ok 1 engine(s): ignition off (after-run 10 s)');
        expect(engine.handleCommand('010C 1')).toBe('7F0122');
        clock.ms += 10_000;
        expect(engine.handleCommand('010C 1')).toBe('NO DATA');
        expect(applyControlCommand('ignition off soon', [engine])).toMatch(/^error ignition off expects/);
        expect(applyControlCommand('ignition running 5', [engine])).toMatch(/^error .*only.*off/);
    });
});

describe('response hint on the vLinker counts CAN frames', () => {
    it('cuts a multi-frame answer off after the hinted number of frames', () => {
        const {engine} = recordedCar();
        expect(lines(engine.handleCommand('017A 1'))).toEqual(['009', expect.stringMatching(/^0:417A[0-9A-F]{8}$/)]);
        expect(lines(engine.handleCommand('0178 1'))).toEqual(['00B', expect.stringMatching(/^0:4178[0-9A-F]{8}$/)]);
        const batch = lines(engine.handleCommand('010C0D0504 1'));
        expect(batch).toEqual(['00A', expect.stringMatching(/^0:410C[0-9A-F]{4}0D[0-9A-F]{2}$/)]);
        expect(lines(engine.handleCommand('017A 2'))).toHaveLength(3);
        expect(lines(engine.handleCommand('017A'))).toHaveLength(3);
    });

    it('returns without the wait window once the hinted frames arrived', () => {
        const {engine} = recordedCar();
        expect(engine.execute('017A 1').latency.waitMs).toBe(0);
        expect(engine.execute('017A 2').latency.waitMs).toBe(0);
        expect(engine.execute('017A 3').latency.waitMs).toBeGreaterThan(0);
        expect(engine.execute('017A').latency.waitMs).toBeGreaterThan(0);
    });

    it('cuts raw frames the same way with headers on', () => {
        const {engine} = recordedCar();
        engine.handleCommand('ATH1');
        expect(lines(engine.handleCommand('017A 1'))).toHaveLength(1);
        expect(lines(engine.handleCommand('017A'))).toHaveLength(2);
    });

    it('treats a zero hint like the response-counting adapters do: nothing is awaited', () => {
        const {engine} = recordedCar();
        expect(engine.handleCommand('017A 0')).toBe('NO DATA');
        expect(engine.handleCommand('010C 0')).toBe('NO DATA');
    });

    it('counts across ECUs in the order they answer', () => {
        const {engine} = recordedCar();
        expect(lines(engine.handleCommand('010C 2'))).toHaveLength(2); // engine ECU, then the TCM
        // Two frames from each ECU: the third frame is the TCM's first.
        expect(lines(engine.handleCommand('010C0D0504 2'))).toHaveLength(3);
        expect(lines(engine.handleCommand('010C0D0504 3')).slice(3)).toEqual([
            expect.stringMatching(/^00[0-9A-F]$/),
            expect.stringMatching(/^0:410C/),
        ]);
        engine.handleCommand('ATH1');
        expect(lines(engine.handleCommand('010C0D0504 3')).map((line) => line.slice(0, 8))).toEqual([
            '18DAF101',
            '18DAF101',
            '18DAF102',
        ]);
    });

    it('leaves hint-ignoring and response-counting adapters alone', () => {
        const clone = recordedCar(CLONE_V21_ADAPTER).engine;
        expect(lines(clone.handleCommand('017A 1'))).toHaveLength(3);
        const counting = recordedCar({...VLINKER_ADAPTER, hintCountsFrames: false}).engine;
        expect(lines(counting.handleCommand('017A 1'))).toHaveLength(3);
    });
});

describe('PID A4 on the recorded car', () => {
    const at = (speedKmh: number, rpm: number) => {
        const {engine} = recordedCar();
        engine.override(0x0d, speedKmh);
        engine.override(0x0c, rpm);
        return engine.handleCommand('01A4 1');
    };

    it('reports the gear alone: support byte 01, gear in the upper nibble of byte B', () => {
        expect(at(0, 930)).toBe('41A401000000'); // recorded at standstill
        expect(at(8, 1251)).toBe('41A401100000');
        expect(at(63, 1722)).toBe('41A401500000');
    });

    it('lets an override pin the gear', () => {
        const {engine} = recordedCar();
        engine.override(0xa4, 7);
        expect(engine.handleCommand('01A4 1')).toBe('41A401700000');
        engine.override(0xa4, null);
        expect(engine.handleCommand('01A4 1')).toBe('NO DATA');
    });

    it('keeps the ratio layout for vehicles that do not declare it', () => {
        let current = 0;
        const engine = createSimulator('default-diesel', {now: () => current, seed: 7});
        current = 60_000; // cruising
        engine.handleCommand('ATE0');
        expect(engine.handleCommand('01A4')).toMatch(/^41A40001[0-9A-F]{4}$/);
    });
});

describe('the padding-printing clone (BLE name OBDII)', () => {
    it('drops a request with three or more PIDs without a word', () => {
        const {engine} = recordedCar(CLONE_OBDII_ADAPTER);
        expect(lines(engine.handleCommand('010C0D 1'))).toHaveLength(2);
        const dropped = engine.execute('010D045C 1');
        expect(dropped).toMatchObject({silent: true, response: '', wire: ''});
        expect(dropped.latency.totalMs).toBe(0);
        expect(engine.execute('010C 1').silent).toBe(false); // the next command is fine
    });

    it('keeps quiet on the links too', async () => {
        const {engine} = recordedCar(CLONE_OBDII_ADAPTER);
        const link = new MemoryLink(engine, {connectDelayMs: 0, responseDelayMs: 0, jitterMs: 0, includeWaitWindow: false});
        const chunks: string[] = [];
        link.onData((chunk) => chunks.push(chunk));
        await link.connect();
        await link.write('010D045C 1\r');
        await link.write('ATI\r');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(chunks.join('')).toBe('ELM327 v2.1\r\r>');
    });

    it('prints single frames with the vehicle padding, multi-frame tails too', () => {
        const {engine} = recordedCar(CLONE_OBDII_ADAPTER);
        expect(lines(engine.handleCommand('0100'))).toEqual(['4100BE3EA813AA', '4100981A0001AA']);
        expect(engine.handleCommand('010D 1')).toMatch(/^410D[0-9A-F]{2}AAAAAAAA\r410D[0-9A-F]{2}AAAAAAAA$/);
        expect(lines(engine.handleCommand('03'))).toEqual(['4300AAAAAAAAAA', '7F0310AAAAAAAA', '4300AAAAAAAAAA']);
        expect(lines(engine.handleCommand('090A'))[4]).toBe('3:6C0000AAAAAAAA');
        expect(engine.handleCommand('0A')).toBe('NO DATA');
    });

    it('answers the probe commands as recorded', () => {
        const {engine} = recordedCar(CLONE_OBDII_ADAPTER);
        expect(engine.handleCommand('ATCS')).toBe('R:00');
        expect(engine.handleCommand('ATIGN')).toBe('ON');
        expect(engine.handleCommand('STI')).toBe('?');
        expect(engine.handleCommand('ATZ')).toBe('\rELM327 v2.1');
    });
});

describe('adapter details from the probe sessions', () => {
    it('tells the two vLinkers apart', () => {
        const fd = recordedCar(VLINKER_FD_ADAPTER).engine;
        expect(fd.handleCommand('ATI')).toBe('ELM327 v2.2');
        expect(fd.handleCommand('STI')).toBe('STN1151 v4.3.2');
        expect(fd.handleCommand('ATCS')).toBe('T:00 R:00 F:0');
        expect(lines(fd.handleCommand('017A 1'))).toHaveLength(2);
        const ios = recordedCar().engine;
        expect(ios.handleCommand('STI')).toBe('?');
        expect(ios.handleCommand('ATCS')).toBe('T:00 R:00 F:0');
    });

    it('answers ATIGN and ATCS on the OBDBLE clone, which reads the battery high', () => {
        const {engine} = recordedCar(CLONE_V21_ADAPTER);
        expect(engine.handleCommand('ATIGN')).toBe('ON');
        expect(engine.handleCommand('ATCS')).toBe('OK');
        expect(Number.parseFloat(engine.handleCommand('ATRV'))).toBeGreaterThan(15);
        expect(Number.parseFloat(recordedCar().engine.handleCommand('ATRV'))).toBeLessThan(14.5);
    });

    it('takes about a second to reset and longer to give up a search than to finish one', () => {
        const {engine} = recordedCar(VLINKER_FD_ADAPTER);
        const calm = {...VLINKER_FD_ADAPTER, latencyJitterMs: 0};
        engine.setAdapter(calm);
        expect(engine.execute('ATZ').latency.totalMs).toBe(960);
        engine.handleCommand('ATE0');
        expect(engine.execute('ATS0').latency.totalMs).toBe(30);
        engine.handleCommand('ATSP0');
        const found = engine.execute('0100').latency;
        expect(found.searchMs).toBe(4850);
        engine.setIgnition('off');
        engine.handleCommand('ATSP0');
        expect(engine.execute('0100').latency.searchMs).toBe(5700);
    });

    it('is slower at AT commands than the base latency on the clones', () => {
        const {engine} = recordedCar({...CLONE_V21_ADAPTER, latencyJitterMs: 0});
        expect(engine.execute('ATS0').latency.baseMs).toBe(68);
        expect(engine.execute('010C 1').latency.baseMs).toBe(20);
    });

    it('lists the new presets', () => {
        expect(ADAPTER_PRESETS['vlinker-fd']).toBe(VLINKER_FD_ADAPTER);
        expect(ADAPTER_PRESETS['clone-obdii']).toBe(CLONE_OBDII_ADAPTER);
    });
});

describe('mode 04 reaches more modules than mode 01', () => {
    it('answers from four modules on the recorded car: two clear, two are still busy', () => {
        const {engine} = recordedCar();
        engine.injectDtc('P0301');
        expect(lines(engine.handleCommand('04'))).toEqual(['44', '7F0478', '44', '7F0478']);
        expect(engine.storedDtcs).toEqual([]);
        // The fourth module takes part in nothing else.
        expect(lines(engine.handleCommand('03'))).toHaveLength(3);
        expect(lines(engine.handleCommand('0100'))).toHaveLength(2);
        expect(lines(engine.handleCommand('22F190'))).toHaveLength(3);
    });

    it('refuses from all four while the engine runs, when the profile says so', () => {
        const clock = {ms: 60_000};
        const engine = new SimulatorEngine({
            now: () => clock.ms,
            seed: 7,
            adapter: VLINKER_ADAPTER,
            profile: {...GASOLINE_PROFILE, clearRequiresEngineOff: true},
        });
        for (const command of ['ATE0', 'ATS0', 'ATSP7']) engine.handleCommand(command);
        expect(lines(engine.handleCommand('04'))).toEqual(['7F0422', '7F0422', '7F0422', '7F0422']);
        engine.setIgnition('key-on');
        expect(lines(engine.handleCommand('04'))).toEqual(['44', '7F0478', '44', '7F0478']);
    });

    it("lets a profile choose each module's answer", () => {
        const profile = {
            ...GASOLINE_PROFILE,
            additionalEcus: [
                {id: '7E9', pids: [0x0c], clearReply: 'none' as const},
                {id: '7EA', pids: [], dtcReply: 'none' as const, clearReply: 'reject' as const},
            ],
        };
        const engine = new SimulatorEngine({now: () => 0, seed: 7, profile});
        engine.handleCommand('ATE0');
        expect(lines(engine.handleCommand('04'))).toEqual(['44', '7F0410']);
    });
});
