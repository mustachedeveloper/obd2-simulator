import {describe, expect, it} from 'vitest';
import {DefaultDrivingModel} from '../../src/core/DefaultDrivingModel';
import {mulberry32} from '../../src/core/prng';
import {ADAPTIVE_TIMING_FACTORS, timeoutWindowMs, waitMsFor} from '../../src/core/timing';
import {handleAtCommand, resetLinkState} from '../../src/core/at-commands';
import {DEFAULT_ADAPTER, GENUINE_ELM_ADAPTER} from '../../src/adapters/presets';
import {mode09Responses} from '../../src/core/mode09';

const noJitter = () => 0;

describe('mulberry32', () => {
    it('is a fixed sequence for a seed, in [0, 1)', () => {
        const a = mulberry32(7);
        const b = mulberry32(7);
        const first = Array.from({length: 5}, () => a());
        expect(first).toEqual(Array.from({length: 5}, () => b()));
        expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
        expect(first).toMatchInlineSnapshot(`
          [
            0.011704753153026104,
            0.06195825757458806,
            0.97690763277933,
            0.6990287057124078,
            0.5214452685322613,
          ]
        `);
        expect(mulberry32(8)()).not.toBe(first[0]);
    });
});

describe('DefaultDrivingModel', () => {
    const model = new DefaultDrivingModel();
    const at = (pid: number, seconds: number) => model.value(pid, seconds, noJitter);

    it('runs the 96 s idle → accel → cruise → decel cycle', () => {
        expect(at(0x0d, 0)).toBe(0);
        expect(at(0x0d, 24)).toBeCloseTo(45, 0); // halfway through acceleration
        expect(at(0x0d, 60)).toBe(90);
        expect(at(0x0d, 92)).toBeCloseTo(45, 0);
        expect(at(0x0d, 96)).toBe(0);
        expect(at(0x0c, 0)).toBe(800);
        expect(at(0x0c, 60)).toBeGreaterThan(at(0x0c, 0) ?? 0);
    });

    it('keeps the odometer and run time monotonic across cycles', () => {
        const odometer = [0, 50, 96, 150, 1000, 10_000].map((s) => at(0xa6, s) ?? 0);
        for (let i = 1; i < odometer.length; i++) expect(odometer[i]).toBeGreaterThanOrEqual(odometer[i - 1] ?? 0);
        expect((at(0xa6, 96) ?? 0) - (at(0xa6, 0) ?? 0)).toBeCloseTo(1.7, 2); // one cycle ≈ 1.7 km
        expect(at(0x1f, 123)).toBe(123);
    });

    it('warms coolant and oil up along saturating curves', () => {
        const coolant = [0, 60, 300, 3000].map((s) => at(0x05, s) ?? 0);
        expect(coolant[0]).toBe(22);
        for (let i = 1; i < coolant.length; i++) expect(coolant[i]).toBeGreaterThan(coolant[i - 1] ?? 0);
        expect(coolant[3]).toBeCloseTo(90, 0);
        expect(at(0x5c, 3000)).toBeGreaterThan(at(0x05, 3000) ?? 0); // oil settles hotter
    });

    it('gates the gear ratio on motion and reports the configured fuel type', () => {
        expect(at(0xa4, 0)).toBeNull();
        expect(at(0xa4, 60)).toBeCloseTo(1, 5);
        expect(new DefaultDrivingModel({fuelType: 4}).value(0x51, 0, noJitter)).toBe(4);
        expect(new DefaultDrivingModel({odometerKm: 1}).value(0xa6, 0, noJitter)).toBe(1);
        expect(at(0xff, 0)).toBeNull();
    });
});

describe('timing', () => {
    const persona = GENUINE_ELM_ADAPTER;

    it('turns the ATST hex into a 4 ms window, scaled by adaptive timing when supported', () => {
        const state = resetLinkState(persona);
        expect(timeoutWindowMs(state, persona)).toBe(200);
        expect(timeoutWindowMs({...state, timeoutHex: '19', adaptiveTiming: 2}, persona)).toBe(50);
        expect(timeoutWindowMs({...state, timeoutHex: '19', adaptiveTiming: 2}, {...persona, adaptiveTiming: false})).toBe(100);
        expect(timeoutWindowMs({...state, timeoutHex: 'ZZ'}, persona)).toBe(0);
        expect(ADAPTIVE_TIMING_FACTORS).toEqual({0: 1, 1: 1, 2: 0.5});
    });

    it('charges the window only for OBD requests without a satisfied hint', () => {
        const state = resetLinkState(persona);
        expect(waitMsFor({kind: 'at', hint: null, responders: 0}, state, persona)).toBe(0);
        expect(waitMsFor({kind: 'fault', hint: null, responders: 0}, state, persona)).toBe(0);
        expect(waitMsFor({kind: 'obd', hint: null, responders: 1}, state, persona)).toBe(200);
        expect(waitMsFor({kind: 'obd', hint: 1, responders: 1}, state, persona)).toBe(0);
        expect(waitMsFor({kind: 'obd', hint: 2, responders: 1}, state, persona)).toBe(200);
        expect(waitMsFor({kind: 'obd', hint: 1, responders: 0}, state, persona)).toBe(200);
        expect(waitMsFor({kind: 'obd', hint: 1, responders: 1}, state, {...persona, honorsResponseHint: false})).toBe(200);
    });
});

describe('AT command table', () => {
    const context = {
        persona: DEFAULT_ADAPTER,
        state: resetLinkState(DEFAULT_ADAPTER),
        vehicleProtocol: '6' as const,
        voltage: () => '14.1V',
        ignitionOn: () => true,
    };

    it('resets the timeout to the persona default on ATST00', () => {
        const set = handleAtCommand('ATST19', context);
        expect(set.state.timeoutHex).toBe('19');
        expect(handleAtCommand('ATST00', {...context, state: set.state}).state.timeoutHex).toBe('32');
    });

    it('acknowledges CAN formatting commands without side effects', () => {
        for (const command of ['ATCAF1', 'ATCFC0', 'ATFCSH7E0', 'ATFCSD300000', 'ATFCSM1', 'ATM0', 'ATAL']) {
            const outcome = handleAtCommand(command, context);
            expect(outcome.lines, command).toEqual(['OK']);
            expect(outcome.state).toEqual(context.state);
        }
        expect(handleAtCommand('ATFCSD', context).lines).toEqual(['?']);
    });
});

describe('mode 09 sources', () => {
    it('serves only what a source declares, and nothing for an empty one', () => {
        const sources = [{id: '7E8', vin: 'WVWZZZ1KZBW123456', name: 'ECM'}, {id: '7E9', cvn: 'A9C9EF55'}, {id: '7EA'}];
        expect(mode09Responses(sources, '00').map((r) => r.ecu)).toEqual(['7E8', '7E9']);
        expect(mode09Responses(sources, '02').map((r) => r.ecu)).toEqual(['7E8']);
        expect(mode09Responses(sources, '06')).toEqual([{ecu: '7E9', payload: [0x49, 0x06, 0x01, 0xa9, 0xc9, 0xef, 0x55]}]);
        expect(mode09Responses(sources, '0A')[0]?.payload).toHaveLength(3 + 20);
        expect(mode09Responses(sources, '08')).toEqual([]);
        expect(mode09Responses(sources, 'ZZ')).toEqual([]);
        expect(mode09Responses(sources, '')).toEqual([]);
    });
});
