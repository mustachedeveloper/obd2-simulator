import {describe, expect, it} from 'vitest';
import {
    CLONE_OBDII_ADAPTER,
    CLONE_V21_ADAPTER,
    DEFAULT_ADAPTER,
    GENUINE_ELM_ADAPTER,
    REFERENCE_PROFILE,
    SimulatorEngine,
    VLINKER_ADAPTER,
} from '../src/index';
import type {AdapterPersona, VehicleProfile} from '../src/index';
import {SYNTHETIC_GASOLINE_PROFILE} from './helpers/synthetic';

// Wire-level fidelity against real ELM327 hardware (see tests/fixtures/wirelog
// for the recordings these rules were read from).

// Hardware personas search for the protocol on the first request in auto
// mode; tests that are not about the search pin the protocol first.
const engineWith = (
    adapter: AdapterPersona = DEFAULT_ADAPTER,
    profile: VehicleProfile = SYNTHETIC_GASOLINE_PROFILE,
    init: string[] = ['ATE0', 'ATSP6'],
) => {
    const engine = new SimulatorEngine({now: () => 0, seed: 7, adapter, profile});
    for (const command of init) engine.handleCommand(command);
    return engine;
};

const lines = (text: string): string[] => text.split(/\r\n?/);

describe('prompt and line framing', () => {
    it('ends every wire response with a blank line and the prompt, CR only by default', () => {
        const engine = engineWith();
        expect(engine.execute('ATRV').wire).toMatch(/^\d+\.\dV\r\r>$/);
        expect(engine.execute('010C').wire).toMatch(/^410C[0-9A-F]{4}\r\r>$/);
    });

    it('switches to CR+LF line endings under ATL1', () => {
        const engine = engineWith();
        expect(engine.execute('ATL1').wire).toBe('OK\r\n\r\n>');
        expect(engine.execute('010C0D').wire).toMatch(/^410C[0-9A-F]{4}0D[0-9A-F]{2}\r\n\r\n>$/);
        expect(engine.execute('ATL0').wire).toBe('OK\r\r>');
    });

    it('echoes the command exactly as typed while echo is on', () => {
        const engine = new SimulatorEngine({now: () => 0, profile: SYNTHETIC_GASOLINE_PROFILE});
        expect(engine.execute('010c 1').response).toMatch(/^010c 1\r410C[0-9A-F]{4}$/);
        expect(engine.execute('ATE0').wire).toBe('ATE0\rOK\r\r>');
        expect(engine.execute('010c 1').response).toMatch(/^410C/);
    });

    it('prints a blank line before the reset banner, with the persona prefix quirk', () => {
        expect(engineWith().handleCommand('ATZ')).toBe('\rELM327 v1.5');
        expect(engineWith(CLONE_V21_ADAPTER).handleCommand('ATZ')).toBe('OKELM327 v2.1');
        expect(engineWith(VLINKER_ADAPTER).handleCommand('ATWS')).toBe('\rELM327 v2.3');
    });
});

describe('spaces (ATS)', () => {
    it('separates bytes with spaces on hardware personas until ATS0', () => {
        const vlinker = engineWith(VLINKER_ADAPTER);
        expect(vlinker.handleCommand('010C 1')).toMatch(/^41 0C [0-9A-F]{2} [0-9A-F]{2}$/);
        expect(vlinker.handleCommand('ATS0')).toBe('OK');
        expect(vlinker.handleCommand('010C 1')).toMatch(/^410C[0-9A-F]{4}$/);
        expect(vlinker.handleCommand('ATS1')).toBe('OK');
        expect(vlinker.handleCommand('0902')).toMatch(
            /^014\r0: 49 02 01 57 56 57\r1: 5A 5A 5A 31 4B 5A 42\r2: 57 31 32 33 34 35 36$/,
        );
        expect(vlinker.linkState.spaces).toBe(true);
    });

    it('keeps the ideal default persona space-free for app-friendly output', () => {
        const engine = engineWith();
        expect(engine.handleCommand('010C')).toMatch(/^410C[0-9A-F]{4}$/);
        engine.handleCommand('ATS1');
        expect(engine.handleCommand('010C')).toMatch(/^41 0C /);
        engine.handleCommand('ATZ');
        engine.handleCommand('ATE0');
        expect(engine.handleCommand('010C')).toMatch(/^410C/);
    });

    it('spaces the header bytes too under ATH1', () => {
        const vlinker = engineWith(VLINKER_ADAPTER, SYNTHETIC_GASOLINE_PROFILE, ['ATE0', 'ATSP6', 'ATH1']);
        // The vLinker prints a single frame as far as its PCI length.
        expect(vlinker.handleCommand('010C 1')).toMatch(/^7E8 04 41 0C [0-9A-F]{2} [0-9A-F]{2}$/);
        const genuine = engineWith(GENUINE_ELM_ADAPTER, SYNTHETIC_GASOLINE_PROFILE, ['ATE0', 'ATSP6', 'ATH1']);
        expect(genuine.handleCommand('010C 1')).toMatch(/^7E8 04 41 0C [0-9A-F]{2} [0-9A-F]{2} 00 00 00$/);
    });
});

describe('protocol search', () => {
    it('prints SEARCHING... and charges the search time on the first request in auto mode', () => {
        const vlinker = engineWith(VLINKER_ADAPTER, SYNTHETIC_GASOLINE_PROFILE, ['ATE0', 'ATS0', 'ATSP0']);
        const first = vlinker.execute('0100');
        expect(lines(first.response)[0]).toBe('SEARCHING...');
        expect(lines(first.response)[1]).toMatch(/^4100/);
        expect(first.latency.searchMs).toBe(VLINKER_ADAPTER.protocolSearchMs);
        expect(first.latency.totalMs).toBeGreaterThanOrEqual(first.latency.searchMs);
        const second = vlinker.execute('0100');
        expect(lines(second.response)[0]).toMatch(/^4100/);
        expect(second.latency.searchMs).toBe(0);
    });

    it('does not search with a fixed protocol, and searches again after ATSP0 / ATZ', () => {
        const vlinker = engineWith(VLINKER_ADAPTER, SYNTHETIC_GASOLINE_PROFILE, ['ATE0', 'ATSP6']);
        expect(vlinker.execute('0100').latency.searchMs).toBe(0);
        vlinker.handleCommand('ATSP0');
        expect(vlinker.execute('0100').latency.searchMs).toBeGreaterThan(0);
        vlinker.handleCommand('ATZ');
        vlinker.handleCommand('ATE0');
        expect(vlinker.execute('0100').latency.searchMs).toBeGreaterThan(0);
    });

    it('reports UNABLE TO CONNECT when nothing answers the probe, and keeps searching', () => {
        const vlinker = engineWith(VLINKER_ADAPTER, SYNTHETIC_GASOLINE_PROFILE, ['ATE0', 'ATS0', 'ATSP0']);
        expect(vlinker.handleCommand('01FF')).toBe('SEARCHING...\rUNABLE TO CONNECT');
        expect(vlinker.handleCommand('01FF')).toBe('SEARCHING...\rUNABLE TO CONNECT');
        expect(vlinker.handleCommand('010C 1')).toMatch(/^SEARCHING\.\.\.\r410C/);
    });

    it('never searches on the ideal default persona', () => {
        expect(engineWith().handleCommand('010C')).toMatch(/^410C/);
    });

    it('reports the detected protocol after auto search from the vehicle profile', () => {
        const reference = engineWith(VLINKER_ADAPTER, REFERENCE_PROFILE, ['ATE0', 'ATS0', 'ATSP0']);
        expect(reference.handleCommand('ATDPN')).toBe('A7');
        expect(reference.handleCommand('ATDP')).toBe('AUTO, ISO 15765-4 (CAN 29/500)');
        expect(engineWith(DEFAULT_ADAPTER, SYNTHETIC_GASOLINE_PROFILE, ['ATE0']).handleCommand('ATDPN')).toBe('A6');
    });
});

describe('29-bit CAN addressing', () => {
    it('prints 29-bit response headers for ISO 15765-4 CAN 29 vehicles', () => {
        const reference = engineWith(VLINKER_ADAPTER, REFERENCE_PROFILE, ['ATE0', 'ATS0', 'ATSP7', 'ATH1']);
        const rpm = lines(reference.handleCommand('010C'));
        // Recorded: '18DAF10104410C0E7E' — the car's own source addresses, and
        // the vLinker prints a single frame only as far as its PCI length.
        expect(rpm[0]).toMatch(/^18DAF10104410C[0-9A-F]{4}$/);
        expect(rpm[1]).toMatch(/^18DAF10204410C[0-9A-F]{4}$/);
        reference.handleCommand('ATS1');
        expect(lines(reference.handleCommand('010C'))[0]).toMatch(/^18 DA F1 01 04 41 0C [0-9A-F]{2} [0-9A-F]{2}$/);
        // Multi-frame output keeps whole frames.
        reference.handleCommand('ATS0');
        expect(lines(reference.handleCommand('017A'))).toEqual([
            expect.stringMatching(/^18DAF1011009417A[0-9A-F]{8}$/),
            expect.stringMatching(/^18DAF10121[0-9A-F]{6}AAAAAAAA$/),
        ]);
        // The clone that pads everything lists both ECUs with the padding (recorded).
        const clone = engineWith(CLONE_OBDII_ADAPTER, REFERENCE_PROFILE, ['ATE0', 'ATS0', 'ATSP7', 'ATH1']);
        expect(lines(clone.handleCommand('010C 1'))).toEqual([
            expect.stringMatching(/^18DAF10104410C[0-9A-F]{4}AAAAAA$/),
            expect.stringMatching(/^18DAF10204410C[0-9A-F]{4}AAAAAA$/),
        ]);
    });

    it('keeps the 0x10 + 8·n mapping for ECUs without a declared source address', () => {
        const profile = {...SYNTHETIC_GASOLINE_PROFILE, protocol: '7' as const, additionalEcus: [{id: '7E9', pids: [0x0c]}]};
        const engine = engineWith(DEFAULT_ADAPTER, profile, ['ATE0', 'ATH1']);
        expect(lines(engine.handleCommand('010C')).map((line) => line.slice(0, 8))).toEqual(['18DAF110', '18DAF118']);
        engine.handleCommand('ATSH18DA18F1');
        expect(lines(engine.handleCommand('010C'))).toEqual([expect.stringMatching(/^18DAF118/)]);
    });

    it('rejects source addresses that are not a byte or collide', () => {
        const base = {...SYNTHETIC_GASOLINE_PROFILE, protocol: '7' as const};
        expect(() => new SimulatorEngine({profile: {...base, sourceAddress: 0x100}})).toThrow(/sourceAddress/);
        expect(
            () => new SimulatorEngine({profile: {...base, sourceAddress: 0x18, additionalEcus: [{id: '7E9', pids: []}]}}),
        ).toThrow(/sourceAddress/);
    });

    it('addresses ECUs physically with 29-bit request headers', () => {
        const reference = engineWith(VLINKER_ADAPTER, REFERENCE_PROFILE, ['ATE0', 'ATS0', 'ATSP7', 'ATH1']);
        reference.handleCommand('ATSH18DA02F1');
        expect(lines(reference.handleCommand('010C'))).toEqual([expect.stringMatching(/^18DAF102/)]);
        reference.handleCommand('ATSH18DA18F1'); // nobody lives there on this car
        expect(reference.handleCommand('010C')).toBe('NO DATA');
        reference.handleCommand('ATSH18DB33F1');
        expect(lines(reference.handleCommand('010C'))).toHaveLength(2);
        reference.handleCommand('ATCRA18DAF102');
        expect(lines(reference.handleCommand('010C'))).toEqual([expect.stringMatching(/^18DAF102/)]);
    });

    it('follows a forced 11-bit protocol even on a 29-bit vehicle (headers only)', () => {
        const reference = engineWith(VLINKER_ADAPTER, REFERENCE_PROFILE, ['ATE0', 'ATS0', 'ATSP6', 'ATH1']);
        expect(lines(reference.handleCommand('010C'))[0]).toMatch(/^7E804410C/);
    });
});

describe('multi-ECU vehicles (profile-defined)', () => {
    it('answers mode 01 from every ECU that serves the PID, masks included', () => {
        const reference = engineWith(CLONE_V21_ADAPTER, REFERENCE_PROFILE, ['ATE0', 'ATS0', 'ATSP7']);
        expect(lines(reference.handleCommand('0100'))).toHaveLength(2);
        expect(lines(reference.handleCommand('010C'))).toHaveLength(2);
        expect(lines(reference.handleCommand('010B'))).toHaveLength(1);
        // The second ECU reports its own readiness bytes.
        expect(lines(reference.handleCommand('0101'))[1]).toBe('410100040000');
        expect(lines(reference.handleCommand('0141'))[1]).toBe('414100040000');
    });

    it('lists DTCs per ECU: the engine list, an empty list, or a negative response', () => {
        const reference = engineWith(CLONE_V21_ADAPTER, REFERENCE_PROFILE, ['ATE0', 'ATS0', 'ATSP7']);
        expect(reference.handleCommand('03')).toBe('4300\r7F0310\r4300');
        expect(reference.handleCommand('07')).toBe('4700\r7F0710\r4700');
        reference.injectDtc('P0301');
        expect(reference.handleCommand('03')).toBe('43010301\r7F0310\r4300');
        reference.handleCommand('ATH1');
        expect(lines(reference.handleCommand('03'))[1]).toMatch(/^18DAF1..037F0310AAAAAAAA$/);
    });

    it('answers NO DATA for permanent codes on vehicles without mode 0A', () => {
        const reference = engineWith(CLONE_V21_ADAPTER, REFERENCE_PROFILE, ['ATE0', 'ATS0', 'ATSP7']);
        expect(reference.handleCommand('0A')).toBe('NO DATA');
        expect(engineWith().handleCommand('0A')).toBe('4A00');
    });

    it('serves mode 09 per ECU: VIN from the engine only, calibration/CVN/name from both', () => {
        const reference = engineWith(CLONE_V21_ADAPTER, REFERENCE_PROFILE, ['ATE0', 'ATS0', 'ATSP7']);
        expect(lines(reference.handleCommand('0902'))[0]).toBe('014');
        expect(lines(reference.handleCommand('0902'))).toHaveLength(4);
        expect(lines(reference.handleCommand('0904')).filter((line) => line === '013')).toHaveLength(2);
        expect(lines(reference.handleCommand('0906'))).toHaveLength(2);
        expect(lines(reference.handleCommand('090A')).filter((line) => line === '017')).toHaveLength(2);
        // 28 in-use counters: 3 + 56 bytes.
        expect(lines(reference.handleCommand('0908'))[0]).toBe('03B');
    });

    it('advertises the vehicle-info set on 0900', () => {
        const engine = engineWith();
        // 02, 04, 06, 08, 0A → bits 2,4,6,8,10 of the 32-bit mask.
        expect(engine.handleCommand('0900')).toBe('490055400000');
        const reference = engineWith(CLONE_V21_ADAPTER, REFERENCE_PROFILE, ['ATE0', 'ATS0', 'ATSP7']);
        expect(lines(reference.handleCommand('0900'))).toEqual(['490055400000', '490014400000']);
    });

    it('serves freeze-frame PID 02 as zeros when no DTC froze a frame', () => {
        const reference = engineWith(CLONE_V21_ADAPTER, REFERENCE_PROFILE, ['ATE0', 'ATS0', 'ATSP7']);
        expect(reference.handleCommand('020200')).toBe('4202000000\r4202000000');
        expect(engineWith().handleCommand('020200')).toBe('4202000000');
    });

    it('keeps single-ECU profiles single-ECU regardless of the adapter', () => {
        expect(lines(engineWith(CLONE_V21_ADAPTER).handleCommand('010C'))).toHaveLength(1);
        expect(lines(engineWith(VLINKER_ADAPTER).handleCommand('03'))).toHaveLength(1);
    });
});

describe('negative responses and unknown requests', () => {
    it('rejects services the vehicle does not implement with 7F xx 11', () => {
        const engine = engineWith();
        expect(engine.handleCommand('22F190')).toBe('7F2211');
        expect(engine.handleCommand('1902')).toBe('7F1911');
        expect(engine.handleCommand('05')).toBe('7F0511');
    });

    it('rejects from every addressed ECU, so a physically addressed module rejects too', () => {
        const reference = engineWith(CLONE_V21_ADAPTER, REFERENCE_PROFILE, ['ATE0', 'ATS0', 'ATSP7']);
        expect(lines(reference.handleCommand('22F190'))).toEqual(['7F2211', '7F2211', '7F2211']);
        reference.handleCommand('ATSH18DA02F1');
        expect(reference.handleCommand('22F190')).toBe('7F2211');
    });

    it('answers ? only for requests that are not hex at all', () => {
        const engine = engineWith();
        expect(engine.handleCommand('01ZZ')).toBe('?');
        expect(engine.handleCommand('BOGUS')).toBe('?');
        expect(engine.handleCommand('0')).toBe('?');
    });
});
