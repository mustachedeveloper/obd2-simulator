import {describe, expect, it} from 'vitest';
import {
    CLONE_V21_ADAPTER,
    DEFAULT_ADAPTER,
    GENUINE_ELM_ADAPTER,
    SimulatorEngine,
    STN_ADAPTER,
    VLINKER_ADAPTER,
} from '../src/index';
import type {AdapterPersona, DrivingModel} from '../src/index';

const engineWith = (adapter?: AdapterPersona, extra: ConstructorParameters<typeof SimulatorEngine>[0] = {}) => {
    const engine = new SimulatorEngine({now: () => 0, seed: 7, adapter, ...extra});
    engine.handleCommand('ATE0');
    return engine;
};

const lines = (response: string): string[] => response.split('\r');

describe('AT command recognition', () => {
    it('answers unknown AT commands with ? like real hardware', () => {
        const engine = engineWith();
        expect(engine.handleCommand('ATBOGUS')).toBe('?');
        expect(engine.handleCommand('ATXYZ1')).toBe('?');
    });

    it('still acknowledges the whole init sequence', () => {
        const engine = engineWith();
        for (const command of ['ATL0', 'ATS0', 'ATH0', 'ATST19', 'ATSP0', 'ATSP6', 'ATAT1', 'ATSH7DF', 'ATCRA', 'ATD', 'ATL1', 'ATS1', 'ATE1']) {
            expect(engine.handleCommand(command), command).toContain('OK');
        }
    });

    it('serves the identity set from the persona', () => {
        const engine = engineWith();
        expect(engine.handleCommand('ATI')).toBe('ELM327 v1.5');
        // Warm start resets echo (like ATZ); it applies from the next command.
        expect(engine.handleCommand('ATWS')).toBe('ELM327 v1.5');
        expect(engine.handleCommand('ATE0')).toBe('ATE0\rOK');
        expect(engine.handleCommand('AT@1')).toBe('OBDII to RS232 Interpreter');
        expect(engine.handleCommand('AT@2')).toBe('?');
        expect(engine.handleCommand('STI')).toBe('?');
        expect(engine.handleCommand('STDI')).toBe('?');
    });

    it('answers STN identity only on STN personas', () => {
        const stn = engineWith(STN_ADAPTER);
        expect(stn.handleCommand('ATZ')).toBe('ELM327 v1.4b');
        stn.handleCommand('ATE0');
        expect(stn.handleCommand('STI')).toBe(STN_ADAPTER.stn?.firmware);
        expect(stn.handleCommand('STDI')).toBe(STN_ADAPTER.stn?.deviceId);
        expect(engineWith(VLINKER_ADAPTER).handleCommand('STI')).toBe('?');
    });

    it('describes the protocol by name and number', () => {
        const engine = engineWith();
        engine.handleCommand('ATSP0');
        expect(engine.handleCommand('ATDP')).toBe('AUTO, ISO 15765-4 (CAN 11/500)');
        expect(engine.handleCommand('ATDPN')).toBe('A6');
        engine.handleCommand('ATSP6');
        expect(engine.handleCommand('ATDP')).toBe('ISO 15765-4 (CAN 11/500)');
        expect(engine.handleCommand('ATDPN')).toBe('6');
    });

    it('reports CAN status and ignition state', () => {
        const engine = engineWith();
        expect(engine.handleCommand('ATCS')).toBe('T:00 R:00 F:00');
        expect(engine.handleCommand('ATIGN')).toBe('ON');
        const stalled: DrivingModel = {value: () => null};
        expect(engineWith(undefined, {model: stalled}).handleCommand('ATIGN')).toBe('OFF');
        expect(engineWith(CLONE_V21_ADAPTER).handleCommand('ATIGN')).toBe('?');
    });

    it('exposes the link state for assertions', () => {
        const engine = engineWith();
        engine.handleCommand('ATH1');
        engine.handleCommand('ATST19');
        engine.handleCommand('ATAT2');
        engine.handleCommand('ATCRA7E8');
        engine.handleCommand('ATSH7E0');
        expect(engine.linkState).toMatchObject({
            echo: false,
            headers: true,
            timeoutHex: '19',
            adaptiveTiming: 2,
            receiveFilter: '7E8',
            requestHeader: '7E0',
        });
        engine.handleCommand('ATZ');
        expect(engine.linkState).toMatchObject({echo: true, headers: false, timeoutHex: '32', adaptiveTiming: 1, receiveFilter: null});
    });
});

describe('multi-ECU responses', () => {
    it('prints one line per responding ECU for PIDs the second ECU serves', () => {
        const clone = engineWith(CLONE_V21_ADAPTER);
        const rpm = lines(clone.handleCommand('010C'));
        expect(rpm).toHaveLength(2);
        expect(rpm.every((line) => line.startsWith('410C'))).toBe(true);
        // Intake pressure is only served by the engine ECU.
        expect(lines(clone.handleCommand('010B'))).toHaveLength(1);
        // The second ECU advertises its own (smaller) support mask.
        const masks = lines(clone.handleCommand('0100'));
        expect(masks).toHaveLength(2);
        expect(masks[0]).not.toBe(masks[1]);
    });

    it('prefixes CAN headers + PCI byte under ATH1 and pads frames to 8 bytes', () => {
        const clone = engineWith(CLONE_V21_ADAPTER);
        clone.handleCommand('ATH1');
        const rpm = lines(clone.handleCommand('010C'));
        expect(rpm[0]).toMatch(/^7E804410C[0-9A-F]{4}000000$/);
        expect(rpm[1]).toMatch(/^7E904410C[0-9A-F]{4}000000$/);
        clone.handleCommand('ATH0');
        expect(lines(clone.handleCommand('010C'))[0]).toMatch(/^410C[0-9A-F]{4}$/);
    });

    it('filters by receive address with ATCRA and clears it without argument', () => {
        const clone = engineWith(CLONE_V21_ADAPTER);
        clone.handleCommand('ATCRA7E9');
        clone.handleCommand('ATH1');
        expect(lines(clone.handleCommand('010C'))).toHaveLength(1);
        expect(clone.handleCommand('010C').startsWith('7E9')).toBe(true);
        clone.handleCommand('ATCRA');
        expect(lines(clone.handleCommand('010C'))).toHaveLength(2);
        clone.handleCommand('ATCRA7EA');
        expect(clone.handleCommand('010C')).toBe('NO DATA');
    });

    it('addresses a single ECU physically via ATSH', () => {
        const clone = engineWith(CLONE_V21_ADAPTER);
        clone.handleCommand('ATH1');
        clone.handleCommand('ATSH7E1');
        const only = lines(clone.handleCommand('010C'));
        expect(only).toHaveLength(1);
        expect(only[0].startsWith('7E9')).toBe(true);
        clone.handleCommand('ATSH7DF');
        expect(lines(clone.handleCommand('010C'))).toHaveLength(2);
        // A response id (or any non-request header) addresses nobody.
        clone.handleCommand('ATSH7E8');
        expect(clone.handleCommand('010C')).toBe('NO DATA');
        clone.handleCommand('ATSH18DB33F1');
        expect(lines(clone.handleCommand('010C'))).toHaveLength(2);
    });

    it('returns after N responses when the hint is honored, all of them otherwise', () => {
        const vlinker = engineWith(VLINKER_ADAPTER);
        expect(lines(vlinker.handleCommand('010C 1'))).toHaveLength(1);
        expect(lines(vlinker.handleCommand('010C 2'))).toHaveLength(2);
        expect(lines(vlinker.handleCommand('010C'))).toHaveLength(2);
        const clone = engineWith(CLONE_V21_ADAPTER);
        expect(lines(clone.handleCommand('010C 1'))).toHaveLength(2);
    });
});

describe('batch requests and multi-frame framing', () => {
    it('packs several PIDs into one frame when they fit', () => {
        const engine = engineWith();
        expect(engine.handleCommand('010C0D')).toMatch(/^410C[0-9A-F]{4}0D[0-9A-F]{2}$/);
    });

    it('prints the ISO-TP long form when the payload exceeds 7 bytes', () => {
        const engine = engineWith();
        const parts = lines(engine.handleCommand('010C0D0504'));
        expect(parts).toEqual([
            '00A',
            expect.stringMatching(/^0:410C[0-9A-F]{4}0D[0-9A-F]{2}$/),
            expect.stringMatching(/^1:05[0-9A-F]{2}04[0-9A-F]{2}$/),
        ]);
    });

    it('prints raw CAN frames with PCI bytes under ATH1', () => {
        const engine = engineWith();
        engine.handleCommand('ATH1');
        const parts = lines(engine.handleCommand('010C0D0504'));
        expect(parts[0]).toMatch(/^7E8100A410C[0-9A-F]{4}0D[0-9A-F]{2}$/);
        expect(parts[1]).toMatch(/^7E82105[0-9A-F]{2}04[0-9A-F]{2}000000$/);
    });

    it('refuses batches above maxPids or when unsupported', () => {
        const engine = engineWith();
        expect(engine.handleCommand('010C0D05040B0E11')).toBe('NO DATA');
        const noBatch = engineWith({...DEFAULT_ADAPTER, batch: {supported: false, maxPids: 1, multiFrameClean: true}});
        expect(noBatch.handleCommand('010C0D')).toBe('NO DATA');
        expect(noBatch.handleCommand('010C')).toMatch(/^410C/);
    });

    it('keeps the two ECUs sequential on a clean adapter', () => {
        const vlinker = engineWith(VLINKER_ADAPTER);
        const parts = lines(vlinker.handleCommand('010C0D0504'));
        expect(parts.map((line) => line.slice(0, 2))).toEqual(['00', '0:', '1:', '00', '0:', '1:']);
    });

    it('interleaves the two ECUs segment by segment on a dirty clone', () => {
        const clone = engineWith(CLONE_V21_ADAPTER);
        const parts = lines(clone.handleCommand('010C0D0504'));
        expect(parts.map((line) => line.slice(0, 2))).toEqual(['00', '00', '0:', '0:', '1:', '1:']);
        clone.handleCommand('ATH1');
        const framed = lines(clone.handleCommand('010C0D0504'));
        expect(framed.map((line) => line.slice(0, 5))).toEqual(['7E810', '7E910', '7E821', '7E921']);
    });

    it('serves single-frame ISO-TP for mode 09 with headers too', () => {
        const engine = engineWith();
        engine.handleCommand('ATH1');
        const parts = lines(engine.handleCommand('0902'));
        expect(parts[0]).toMatch(/^7E81014490201/);
        expect(parts[1]).toMatch(/^7E821/);
        expect(parts[2]).toMatch(/^7E822/);
    });
});

describe('latency model', () => {
    it('adds the ATST window unless the hint matches the responder count', () => {
        const engine = engineWith();
        engine.handleCommand('ATST19');
        expect(engine.execute('010C 1').latency.waitMs).toBe(0);
        expect(engine.execute('010C').latency.waitMs).toBe(100);
        expect(engine.execute('010C 2').latency.waitMs).toBe(100);
        expect(engine.execute('01FF').latency.waitMs).toBe(100);
        expect(engine.execute('ATRV').latency.waitMs).toBe(0);
        expect(engine.execute('ATBOGUS').latency.waitMs).toBe(0);
    });

    it('ignores the hint on a clone and waits the full window', () => {
        const clone = engineWith(CLONE_V21_ADAPTER);
        clone.handleCommand('ATST19');
        expect(clone.execute('010C 2').latency.waitMs).toBe(100);
        expect(clone.execute('010C 1').latency.waitMs).toBe(100);
    });

    it('resets the window to the ELM default (32h = 200 ms) on ATZ', () => {
        const engine = engineWith();
        expect(engine.execute('010C').latency.waitMs).toBe(200);
        engine.handleCommand('ATST0A');
        expect(engine.execute('010C').latency.waitMs).toBe(40);
        engine.handleCommand('ATZ');
        expect(engine.execute('010C').latency.waitMs).toBe(200);
    });

    it('scales the window with adaptive timing only when the persona supports it', () => {
        const genuine = engineWith(GENUINE_ELM_ADAPTER);
        genuine.handleCommand('ATST19');
        expect(genuine.handleCommand('ATAT2')).toBe('OK');
        expect(genuine.execute('010C').latency.waitMs).toBe(50);
        genuine.handleCommand('ATAT0');
        expect(genuine.execute('010C').latency.waitMs).toBe(100);

        const clone = engineWith(CLONE_V21_ADAPTER);
        clone.handleCommand('ATST19');
        expect(clone.handleCommand('ATAT2')).toBe('OK');
        expect(clone.execute('010C 2').latency.waitMs).toBe(100);
    });

    it('sums base, jitter and wait into the total', () => {
        const vlinker = engineWith(VLINKER_ADAPTER);
        vlinker.handleCommand('ATST19');
        const result = vlinker.execute('010C 1');
        expect(result.latency.baseMs).toBe(VLINKER_ADAPTER.baseLatencyMs);
        expect(Math.abs(result.latency.jitterMs)).toBeLessThanOrEqual(VLINKER_ADAPTER.latencyJitterMs);
        expect(result.latency.totalMs).toBe(result.latency.baseMs + result.latency.jitterMs + result.latency.waitMs);
        expect(result.response).toMatch(/^410C/);
        expect(result.command).toBe('010C1');
    });

    it('lets a hook replace the base latency per command', () => {
        const engine = engineWith(undefined, {latencyFor: (command) => (command.startsWith('AT') ? 5 : 70)});
        expect(engine.execute('ATRV').latency.totalMs).toBe(5);
        expect(engine.execute('010C 1').latency.totalMs).toBe(70);
    });

    it('is deterministic for the same seed even with jitter', () => {
        const run = () => {
            const engine = engineWith(CLONE_V21_ADAPTER);
            return ['010C', '010D', 'ATRV'].map((cmd) => engine.execute(cmd).latency.totalMs);
        };
        expect(run()).toEqual(run());
    });
});

describe('persona switching', () => {
    it('swaps identity and timing mid-session', () => {
        const engine = engineWith(CLONE_V21_ADAPTER);
        expect(engine.execute('010C 1').latency.baseMs).toBe(CLONE_V21_ADAPTER.baseLatencyMs);
        engine.setAdapter({...CLONE_V21_ADAPTER, baseLatencyMs: 468, latencyJitterMs: 0});
        expect(engine.adapter.baseLatencyMs).toBe(468);
        expect(engine.execute('010C 1').latency.baseMs).toBe(468);
        engine.setAdapter(VLINKER_ADAPTER);
        expect(engine.handleCommand('ATZ')).toBe('ELM327 v2.3');
    });

    it('rejects personas without any responding ECU', () => {
        const broken = {...DEFAULT_ADAPTER, respondingEcus: []};
        expect(() => new SimulatorEngine({adapter: broken})).toThrow(/responding ECU/);
        expect(() => engineWith().setAdapter(broken)).toThrow(/responding ECU/);
    });

    it('keeps the default persona identical to the pre-persona behaviour', () => {
        const engine = new SimulatorEngine({now: () => 0});
        expect(engine.handleCommand('ATZ')).toBe('ATZ\rELM327 v1.5');
        expect(engine.handleCommand('ATE0')).toBe('ATE0\rOK');
        expect(engine.handleCommand('ATL0')).toBe('OK');
        expect(engine.handleCommand('ATSP0')).toBe('OK');
        expect(engine.handleCommand('ATDPN')).toBe('A6');
        expect(lines(engine.handleCommand('010C'))).toHaveLength(1);
        expect(engine.adapter).toBe(DEFAULT_ADAPTER);
    });
});
