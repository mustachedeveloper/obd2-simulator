import {describe, expect, it} from 'vitest';
import {
    DIESEL_PROFILE,
    GASOLINE_PROFILE,
    HYBRID_PROFILE,
    PID_ENCODERS,
    REFERENCE_PROFILE,
    SimulatorEngine,
    dieselDrivingModel,
    hybridDrivingModel,
} from '../src/index';
import type {DrivingModel, VehicleProfile} from '../src/index';

const engineFor = (profile: VehicleProfile, model?: DrivingModel) => {
    let current = 0;
    const engine = new SimulatorEngine({profile, model, now: () => current, seed: 7});
    current = 60_000;
    engine.handleCommand('ATE0');
    return engine;
};

const BUILT_IN: readonly [string, VehicleProfile, DrivingModel | undefined][] = [
    ['gasoline', GASOLINE_PROFILE, undefined],
    ['diesel', DIESEL_PROFILE, dieselDrivingModel()],
    ['reference', REFERENCE_PROFILE, undefined],
    ['hybrid', HYBRID_PROFILE, hybridDrivingModel()],
];

describe('built-in profiles', () => {
    it.each(BUILT_IN)('%s advertises only PIDs it can actually serve', (_name, profile, model) => {
        const engine = engineFor(profile, model);
        for (const pid of profile.pids) {
            expect(PID_ENCODERS[pid], `PID 0x${pid.toString(16)} has no encoder`).toBeDefined();
            expect(
                engine.handleCommand(`01${pid.toString(16).toUpperCase().padStart(2, '0')}`),
                `PID 0x${pid.toString(16)}`,
            ).not.toBe('NO DATA');
        }
        for (const ecu of profile.additionalEcus ?? []) {
            // Status PIDs 01/41 are served by every ECU without being listed.
            for (const pid of ecu.pids.filter((p) => p !== 0x01 && p !== 0x41)) {
                expect(profile.pids, `${ecu.id} PID 0x${pid.toString(16)}`).toContain(pid);
            }
        }
    });

    it.each(BUILT_IN)('%s has a well-formed identity', (_name, profile) => {
        expect(profile.vin).toMatch(/^[A-HJ-NPR-Z0-9]{17}$/);
        expect(profile.cvn).toMatch(/^[0-9A-F]{8}$/);
        expect(profile.calibrationId.length).toBeLessThanOrEqual(16);
        expect(profile.ecuName.length).toBeLessThanOrEqual(20);
        expect(profile.performanceCounters.length).toBeGreaterThanOrEqual(4);
    });
});

describe('hybrid profile', () => {
    it('reports a hybrid powertrain and its battery pack', () => {
        const hybrid = engineFor(HYBRID_PROFILE, hybridDrivingModel());
        expect(hybrid.handleCommand('0151')).toBe('415111'); // fuel type 0x11 = hybrid gasoline
        const pack = hybrid.handleCommand('015B');
        expect(pack).toMatch(/^415B[0-9A-F]{2}$/);
        expect((Number.parseInt(pack.slice(4), 16) * 100) / 255).toBeGreaterThan(40);
        // Spark-ignition readiness and performance counters like the gasoline car.
        expect(hybrid.handleCommand('0908')).not.toBe('NO DATA');
        expect(hybrid.handleCommand('090B')).toBe('NO DATA');
    });

    it('stops the combustion engine at standstill', () => {
        let current = 0;
        const hybrid = new SimulatorEngine({profile: HYBRID_PROFILE, model: hybridDrivingModel(), now: () => current, seed: 7});
        hybrid.handleCommand('ATE0');
        expect(hybrid.handleCommand('010C')).toBe('410C0000'); // idle phase: engine off, EV mode
        // Every engine-derived signal agrees the engine is off.
        expect(hybrid.handleCommand('0104')).toBe('410400');
        expect(hybrid.handleCommand('0110')).toBe('41100000');
        expect(hybrid.handleCommand('0166')).toBe('41660300000000');
        expect(hybrid.handleCommand('010B')).toBe('410B65'); // atmospheric, no vacuum
        expect(Number.parseInt(hybrid.handleCommand('0142').slice(4), 16) / 1000).toBeLessThan(13);
        expect(Number.parseFloat(hybrid.handleCommand('ATRV'))).toBeLessThan(13);
        expect(hybrid.handleCommand('015E')).toBe('415E0000');
        current = 60_000;
        expect(Number.parseInt(hybrid.handleCommand('010C').slice(4), 16) / 4).toBeGreaterThan(1000);
        expect(hybrid.handleCommand('ATIGN')).toBe('ON');
    });
});
