import {describe, expect, it} from 'vitest';
import {
    DEFAULT_SIMULATOR_ID,
    DIESEL_PROFILE,
    GASOLINE_PROFILE,
    SIMULATORS,
    SimulatorEngine,
    VLINKER_ADAPTER,
    createSimulator,
    getSimulator,
    listSimulators,
} from '../src/index';
import type {DrivingModel, SimulatorDefinition} from '../src/index';

const ID_FORMAT = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe('simulator registry', () => {
    it('offers the default gasoline and diesel simulators', () => {
        expect(listSimulators().map((simulator) => simulator.id)).toEqual(['default-gasoline', 'default-diesel']);
        expect(getSimulator('default-gasoline').profile).toBe(GASOLINE_PROFILE);
        expect(getSimulator('default-diesel').profile).toBe(DIESEL_PROFILE);
    });

    it('defaults to the gasoline simulator', () => {
        expect(DEFAULT_SIMULATOR_ID).toBe('default-gasoline');
        expect(SIMULATORS[DEFAULT_SIMULATOR_ID]).toBe(getSimulator('default-gasoline'));
    });

    it.each(listSimulators())('$id is a complete, self-consistent definition', (simulator: SimulatorDefinition) => {
        expect(simulator.id).toMatch(ID_FORMAT);
        expect(getSimulator(simulator.id)).toBe(simulator);
        expect(simulator.label.length).toBeGreaterThan(0);
        expect(simulator.description.length).toBeGreaterThan(0);
        expect(['synthetic', 'recorded']).toContain(simulator.kind);
        // Recorded vehicles say where their data came from.
        if (simulator.kind === 'recorded') expect(simulator.provenance).toBeDefined();
    });

    it.each(listSimulators())('$id builds a fresh driving model per call', (simulator: SimulatorDefinition) => {
        const first = simulator.createModel();
        expect(typeof first.value).toBe('function');
        expect(simulator.createModel()).not.toBe(first);
    });

    it('rejects an unknown id and names the valid ones', () => {
        expect(() => getSimulator('tesla')).toThrow('unknown simulator "tesla" — expected default-gasoline | default-diesel');
    });

    it('does not resolve inherited object keys', () => {
        expect(() => getSimulator('toString')).toThrow(/unknown simulator/);
        expect(() => getSimulator('__proto__')).toThrow(/unknown simulator/);
    });
});

describe('createSimulator', () => {
    const at = (ms: number) => ({now: () => ms});

    it('runs the default gasoline simulator when nothing is selected', () => {
        const engine = createSimulator();
        expect(engine).toBeInstanceOf(SimulatorEngine);
        expect(engine.profile).toBe(GASOLINE_PROFILE);
    });

    it('pairs the selected profile with its driving model', () => {
        const engine = createSimulator('default-diesel', at(0));
        expect(engine.profile).toBe(DIESEL_PROFILE);
        engine.handleCommand('ATE0');
        expect(engine.handleCommand('0151')).toBe('415104'); // fuel type 4 = diesel
    });

    it('behaves exactly like an engine wired by hand', () => {
        const definition = getSimulator('default-diesel');
        const byHand = new SimulatorEngine({
            profile: definition.profile,
            model: definition.createModel(),
            seed: 7,
            ...at(30_000),
        });
        const created = createSimulator('default-diesel', {seed: 7, ...at(30_000)});
        for (const command of ['ATZ', 'ATE0', '0100', '010C', '0105', '0902', '03']) {
            expect(created.handleCommand(command), command).toBe(byHand.handleCommand(command));
        }
    });

    it('passes engine options through', () => {
        const engine = createSimulator('default-gasoline', {adapter: VLINKER_ADAPTER});
        expect(engine.adapter).toBe(VLINKER_ADAPTER);
    });

    it('lets the caller replace the driving model', () => {
        const model: DrivingModel = {value: (pid) => (pid === 0x0d ? 123 : null)};
        const engine = createSimulator('default-diesel', {model});
        engine.handleCommand('ATE0');
        expect(engine.handleCommand('010D')).toBe('410D7B');
    });

    it('accepts a definition that is not in the registry', () => {
        const custom: SimulatorDefinition = {
            ...getSimulator('default-gasoline'),
            profile: {...GASOLINE_PROFILE, vin: 'WVWZZZ1KZBW999999'},
        };
        expect(createSimulator(custom).profile.vin).toBe('WVWZZZ1KZBW999999');
    });

    it('never lets an untyped caller swap the profile', () => {
        const smuggled = {profile: DIESEL_PROFILE} as object;
        expect(createSimulator('default-gasoline', smuggled).profile).toBe(GASOLINE_PROFILE);
    });

    it('rejects an unknown id', () => {
        expect(() => createSimulator('nope')).toThrow(/unknown simulator "nope"/);
    });
});
