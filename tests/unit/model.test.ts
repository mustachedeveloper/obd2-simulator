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

describe('mode 09 ECU name (infotype 0A)', () => {
    const nameOf = (name: string) => mode09Responses([{id: '7E8', name}], '0A')[0]?.payload.slice(3) ?? [];
    const text = (bytes: readonly number[]) => bytes.map((byte) => (byte === 0 ? '·' : String.fromCharCode(byte))).join('');

    it('sends the acronym as a NUL-filled 4-byte field, like vehicles do', () => {
        expect(text(nameOf('ECM-EngineControl'))).toBe('ECM·-EngineControl··');
        expect(text(nameOf('TCM-TransmisCtrl'))).toBe('TCM·-TransmisCtrl···');
        expect(text(nameOf('ABS1-Brakes'))).toBe('ABS1-Brakes·········');
    });

    it('sends other names unchanged and never more than 20 bytes', () => {
        expect(text(nameOf('Engine'))).toBe('Engine··············');
        expect(nameOf('ECM-AnExtremelyLongEcuNameIndeed')).toHaveLength(20);
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

describe('static state traits', () => {
    const at = (model: DefaultDrivingModel, pid: number, s = 0) => model.value(pid, s, noJitter);

    it('seeds the odometer, fuel level, in-use counters and ambient temperature from the traits', () => {
        const car = new DefaultDrivingModel({
            traits: {odometerKm: 51_160.4, fuelLevelPct: 97, warmupsSinceClear: 83, distanceSinceClearKm: 2874, ambientC: 31},
        });
        expect(at(car, 0xa6)).toBe(51_160.4);
        expect(at(car, 0x2f)).toBe(97);
        expect(at(car, 0x30)).toBe(83);
        expect(at(car, 0x31)).toBe(2874);
        expect(at(car, 0x46)).toBe(31);
        expect((at(car, 0x31, 96) ?? 0) - 2874).toBeCloseTo(1.7, 2); // distance since clear accumulates like the odometer
    });

    it('keeps the synthetic defaults and lets the odometer option override the trait', () => {
        const synthetic = new DefaultDrivingModel();
        expect([0xa6, 0x2f, 0x30, 0x31, 0x46].map((pid) => at(synthetic, pid))).toEqual([84_213, 62, 42, 1200, 22]);
        expect(at(new DefaultDrivingModel({odometerKm: 1, traits: {odometerKm: 5}}), 0xa6)).toBe(1);
        expect(() => new DefaultDrivingModel({traits: {fuelLevelPct: 101}})).toThrow(/fuelLevelPct/);
    });

    it('moves a fitted ambient sensor to the chosen day, heat soak included', () => {
        // 35 − 0.5·2 − 0.06·60 = 30.4 °C at the reference cruise state (2000 rpm, 60 km/h).
        const signals = {0x46: {base: 35, perLoadPct: 0, perKrpm: -0.5, perKmh: -0.06, min: -40, max: 80, noise: 0}};
        const recorded = new DefaultDrivingModel({signals, traits: {ambientC: 30.4}});
        const winter = new DefaultDrivingModel({signals, traits: {ambientC: 5}});
        expect(at(recorded, 0x46, 0)).toBeCloseTo(34.6, 5); // the fit as recorded (800 rpm idle: 35 − 0.4)
        expect(at(winter, 0x46, 0)).toBeCloseTo(34.6 - 25.4, 5);
        expect(at(new DefaultDrivingModel({signals}), 0x46, 0)).toBeCloseTo(34.6, 5); // no day chosen: the fit as is
        expect(at(winter, 0x46, 50)).toBeCloseTo((at(recorded, 0x46, 50) ?? 0) - 25.4, 5);
    });

    it('serves aux I/O, fuel pressure control, engine fuel rate and exhaust flow from the same state', () => {
        const model = new DefaultDrivingModel();
        expect(at(model, 0x65, 0)).toBe(0); // standing: not in drive
        expect(at(model, 0x65, 60)).toBe(1);
        expect(at(model, 0x6d, 60)).toBeGreaterThan(5000); // direct-injection rail, kPa
        expect(at(model, 0x9d, 60)).toBeCloseTo((at(model, 0x5e, 60) ?? 0) * 0.207, 2); // g/s of gasoline from L/h
        expect(at(model, 0x9e, 60)).toBeCloseTo((at(model, 0x10, 60) ?? 0) * 3.845, 2); // kg/h of exhaust from g/s of air
        const hybrid = new DefaultDrivingModel({engineOffAtStandstill: true});
        expect([0x9d, 0x9e].map((pid) => at(hybrid, pid, 0))).toEqual([0, 0]);
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

    it('lets a persona say how much of the window its adaptive timing (AT1) really waits', () => {
        const state = resetLinkState(persona);
        const quick = {...persona, adaptiveTiming: true, adaptiveTimingFactor: 0.55};
        expect(timeoutWindowMs({...state, timeoutHex: '19', adaptiveTiming: 1}, quick)).toBe(55);
        expect(timeoutWindowMs({...state, timeoutHex: '19', adaptiveTiming: 2}, quick)).toBe(50); // AT2 keeps its own factor
        expect(timeoutWindowMs({...state, timeoutHex: '19', adaptiveTiming: 0}, quick)).toBe(100);
        expect(timeoutWindowMs({...state, timeoutHex: '19', adaptiveTiming: 1}, {...quick, adaptiveTiming: false})).toBe(100);
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
