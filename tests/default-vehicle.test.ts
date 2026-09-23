import {describe, expect, it} from 'vitest';
import {
    DEFAULT_GASOLINE_SIMULATOR,
    GASOLINE_PROFILE,
    PID_ENCODERS,
    REFERENCE_PROFILE,
    SimulatorEngine,
    VLINKER_ADAPTER,
    VLINKER_FD_ADAPTER,
    createSimulator,
    gasolineDrivingModel,
} from '../src/index';
import {CYCLE, SIGNALS, TRAITS} from '../src/vehicles/gasoline/driving';

// The default gasoline vehicle is recorded from a real car. These are the
// answers that car gave (vLinker, spaces off, headers off) — static ones
// must come back byte for byte; only the VIN serial is synthetic.

const noJitter = () => 0;
const lines = (text: string) => text.split('\r').filter(Boolean);

function recordedCar(): SimulatorEngine {
    const engine = createSimulator('default-gasoline', {now: () => 60_000, seed: 7, adapter: VLINKER_ADAPTER});
    for (const command of ['ATE0', 'ATL0', 'ATS0', 'ATSP7']) engine.handleCommand(command);
    return engine;
}

describe('default gasoline vehicle — identity', () => {
    const RECORDED: readonly (readonly [string, readonly string[]])[] = [
        ['0100', ['4100BE3EA813', '4100981A0001']],
        ['0100 1', ['4100BE3EA813']],
        ['0140 1', ['4140FED0AC15']],
        ['0101', ['41010007F100', '410100040000']],
        ['0906', ['490601AD343D35', '490601A9C9EF55']],
        ['0600', ['4600C0000001']],
        ['0620', ['462080000809']],
        ['0640', ['4640C0000001']],
        ['06A0', ['46A078004000']],
        ['03', ['4300', '7F0310', '4300']],
        ['07', ['4700', '7F0710', '4700']],
        ['0A', ['NO DATA']],
        ['ATDPN', ['A7']],
    ];

    it.each(RECORDED)('%s answers like the car', (command, expected) => {
        const engine = recordedCar();
        if (command === 'ATDPN') {
            engine.handleCommand('ATSP0');
            engine.handleCommand('0100');
        }
        expect(lines(engine.handleCommand(command))).toEqual(expected);
    });

    it('advertises every PID the car advertises, and can encode all of them', () => {
        const engine = recordedCar();
        const mask = (command: string) => Number.parseInt(lines(engine.handleCommand(command))[0]?.slice(4) ?? '', 16);
        expect(mask('0120 1')).toBe(0x8007b011);
        expect(mask('0160 1')).toBe(0x6b09a141);
        expect(mask('0180 1')).toBe(0x0024000d);
        for (const pid of GASOLINE_PROFILE.pids) expect(PID_ENCODERS[pid], `PID ${pid.toString(16)}`).toBeDefined();
    });

    it('starts where the last recording left the car: odometer, fuel, in-use counters, the day', () => {
        const engine = recordedCar();
        expect(TRAITS.odometerKm).toBeGreaterThan(50_000);
        expect(TRAITS.fuelLevelPct).toBeGreaterThan(0);
        expect(TRAITS.warmupsSinceClear).toBeGreaterThan(0);
        expect(TRAITS.distanceSinceClearKm).toBeGreaterThan(0);
        expect(TRAITS.ambientC).toBeGreaterThan(0);
        const word = (command: string) => Number.parseInt(lines(engine.handleCommand(command))[0]?.slice(4) ?? '', 16);
        expect(word('0130 1')).toBe(TRAITS.warmupsSinceClear);
        expect(word('0131 1')).toBe(Math.round(TRAITS.distanceSinceClearKm ?? 0));
        expect(word('01A6 1') / 10).toBeCloseTo(TRAITS.odometerKm ?? 0, 0);
    });

    it('vLinker: an unhinted batch returns after ≈ 86 ms with ATST19, a hinted one after ≈ 30 (adaptive timing)', () => {
        // Recorded on the vLinker FD: 133 000 unhinted batches, median 86 ms (p10 71, p90 97); hinted 31 ms.
        const engine = createSimulator('default-gasoline', {now: () => 60_000, seed: 7, adapter: VLINKER_FD_ADAPTER});
        for (const command of ['ATE0', 'ATL0', 'ATS0', 'ATST19', 'ATSP7']) engine.handleCommand(command);
        const batch = engine.execute('010C5E0D').latency;
        expect(batch.waitMs).toBe(55);
        expect(batch.totalMs).toBeGreaterThan(75);
        expect(batch.totalMs).toBeLessThan(95);
        expect(engine.execute('010C5E 1').latency.waitMs).toBe(0);
        engine.handleCommand('ATAT0');
        expect(engine.execute('010C5E0D').latency.waitMs).toBe(100);
    });

    it('pads frames with AA like the car: the last segment on the vLinker, never a single frame', () => {
        const engine = recordedCar();
        expect(GASOLINE_PROFILE.framePadding).toBe(0xaa);
        // Recorded: 013 / 0:490401303545 / 1:30313945423431 / 2:38304245414AAA, then the same for the TCM.
        expect(lines(engine.handleCommand('0904'))).toEqual([
            '013',
            '0:490401303545',
            '1:30313945423431',
            '2:38304245414AAA',
            '013',
            '0:490401304357',
            '1:39303635353645',
            '2:432B30353632AA',
        ]);
        // Recorded: 017 / 0:490A0145434D / 1:002D456E67696E / 2:65436F6E74726F / 3:6C0000AAAAAAAA …
        expect(lines(engine.handleCommand('090A')).slice(0, 5)).toEqual([
            '017',
            '0:490A0145434D',
            '1:002D456E67696E',
            '2:65436F6E74726F',
            '3:6C0000AAAAAAAA',
        ]);
        expect(lines(engine.handleCommand('010C 1'))[0]).toMatch(/^410C[0-9A-F]{4}$/);
    });

    it('follows the car where signals were fitted', () => {
        const model = gasolineDrivingModel();
        // Boosted engine: the manifold goes well above atmospheric under load, and sits in vacuum at idle.
        const map = Array.from({length: 900}, (_, second) => model.value(0x0b, second, noJitter) ?? 0);
        expect(Math.max(...map)).toBeGreaterThan(110);
        expect(Math.min(...map)).toBeLessThan(45);
        expect(model.value(0x8e, 100, noJitter)).toBe(5); // friction torque: +5 %, as recorded
        expect(model.value(0x63, 100, noJitter)).toBe(250);
    });

    it('names both ECUs and reports 28 in-use counters', () => {
        const engine = recordedCar();
        const name = lines(engine.handleCommand('090A'));
        expect(name.filter((line) => line === '017')).toHaveLength(2);
        expect(lines(engine.handleCommand('0908'))[0]).toBe('03B');
        expect(lines(engine.handleCommand('0904')).filter((line) => line === '013')).toHaveLength(2);
    });

    it('keeps manufacturer, model and year in the VIN and nothing of the real serial', () => {
        expect(GASOLINE_PROFILE.vin).toMatch(/^[A-HJ-NPR-Z0-9]{11}123456$/);
        expect(GASOLINE_PROFILE.protocol).toBe('7');
        expect(GASOLINE_PROFILE.additionalEcus?.map((ecu) => ecu.id)).toEqual(['7EA', '7E9', '7EB']);
    });

    it('is a recorded simulator with provenance and no identifying data', () => {
        expect(DEFAULT_GASOLINE_SIMULATOR.kind).toBe('recorded');
        expect(DEFAULT_GASOLINE_SIMULATOR.provenance?.sessions).toBeGreaterThan(0);
        expect(DEFAULT_GASOLINE_SIMULATOR.provenance?.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Object.keys(DEFAULT_GASOLINE_SIMULATOR.provenance ?? {}).sort()).toEqual([
            'from',
            'importerVersion',
            'sessions',
            'to',
        ]);
    });

    it('is what REFERENCE_PROFILE always described', () => {
        expect(REFERENCE_PROFILE).toEqual({...GASOLINE_PROFILE, name: 'reference'});
    });
});

describe('default gasoline vehicle — driving', () => {
    const model = gasolineDrivingModel();

    it('replays the recorded drive', () => {
        expect(CYCLE.stepSeconds).toBe(1);
        expect(CYCLE.speedKmh[0]).toBe(0);
        expect(CYCLE.speedKmh[CYCLE.speedKmh.length - 1]).toBe(0);
        for (const second of [0, 120, 450, 899]) {
            expect(model.value(0x0d, second, noJitter)).toBe(CYCLE.speedKmh[second]);
            expect(model.value(0x0c, second, noJitter)).toBe(CYCLE.rpm[second]);
            expect(model.value(0x5e, second, noJitter)).toBe(CYCLE.fuelRateLph?.[second]);
        }
        expect(model.value(0x0d, 900 + 120, noJitter)).toBe(CYCLE.speedKmh[120]);
    });

    it('stays within what a passenger car does', () => {
        expect(Math.max(...CYCLE.speedKmh)).toBeGreaterThan(60);
        expect(Math.max(...CYCLE.speedKmh)).toBeLessThan(140);
        expect(Math.max(...CYCLE.rpm)).toBeLessThan(5000);
        expect(Math.max(...CYCLE.engineLoadPct)).toBeLessThanOrEqual(100);
        expect(Math.max(...CYCLE.throttlePct)).toBeLessThanOrEqual(100);
    });

    it('carries the measured traits', () => {
        expect(TRAITS).toEqual({
            idleRpm: 930,
            coolantTargetC: 93,
            chargingVoltage: 13.9,
            longTermFuelTrimPct: -5.5,
            intakeTempC: 42,
            // Where the latest recording left the car.
            odometerKm: 51159.7,
            fuelLevelPct: 86,
            warmupsSinceClear: 83,
            distanceSinceClearKm: 2874,
            // From the 22 sessions that began with a cold engine.
            coolantStartC: 46,
            coolantWarmupTauS: 160,
            oilOverCoolantC: 4,
            // The fitted ambient sensor at the reference cruise state.
            ambientC: 30.4,
        });
        expect(model.value(0x05, 0, noJitter)).toBe(46);
        expect(model.value(0x5c, 100_000, noJitter)).toBeCloseTo(97, 3);
        expect(model.value(0x05, 100_000, noJitter)).toBeCloseTo(93, 3);
        // Long-term fuel trim comes from the fitted signals, which win over the trait.
        expect(model.value(0x07, 0, noJitter)).toBe(SIGNALS[0x07]?.base);
    });

    it('is the model of a bare `new SimulatorEngine()`', () => {
        let current = 0;
        const at = {now: () => current, seed: 3};
        const bare = new SimulatorEngine(at);
        const created = createSimulator(undefined, at);
        current = 120_000; // two minutes into the drive
        for (const engine of [bare, created]) engine.handleCommand('ATE0');
        for (const command of ['010C 1', '010D 1', '015E 1', '0105 1']) {
            expect(created.handleCommand(command), command).toBe(bare.handleCommand(command));
        }
        const rpm = Number.parseInt(bare.handleCommand('010C 1').slice(4), 16) / 4;
        expect(rpm).toBeCloseTo(CYCLE.rpm[120] ?? 0, 0);
    });

    it('gives any explicitly passed profile the synthetic cycle unless a model comes with it', () => {
        let current = 0;
        const at = {now: () => current, seed: 3};
        // The same rule for the default profile, an alias and a variant of it.
        const engines = [GASOLINE_PROFILE, REFERENCE_PROFILE, {...GASOLINE_PROFILE, vin: 'TMBAN8NZ2SC654321'}].map(
            (profile) => new SimulatorEngine({...at, profile}),
        );
        const paired = new SimulatorEngine({...at, profile: REFERENCE_PROFILE, model: gasolineDrivingModel()});
        current = 60_000; // synthetic cycle: cruising at ~90 km/h; the recorded drive is elsewhere
        for (const engine of [...engines, paired]) engine.handleCommand('ATE0');
        const speed = (engine: SimulatorEngine) => Number.parseInt(engine.handleCommand('010D 1').slice(4), 16);
        for (const engine of engines) expect(speed(engine)).toBeGreaterThan(85);
        expect(speed(paired)).toBe(CYCLE.speedKmh[60]);
    });

    it('keeps the bundle small: the generated data stays under 32 KB', async () => {
        const {readFileSync} = await import('node:fs');
        const bytes = ['driving', 'profile']
            .map((name) => readFileSync(new URL(`../src/vehicles/gasoline/${name}.ts`, import.meta.url)).length)
            .reduce((sum, size) => sum + size, 0);
        expect(bytes).toBeLessThan(32 * 1024);
    });
});
