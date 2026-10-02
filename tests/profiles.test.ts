import {describe, expect, it} from 'vitest';
import {DefaultDrivingModel} from '../src/core/DefaultDrivingModel';
import {SYNTHETIC_GASOLINE_PROFILE} from './helpers/synthetic';
import {DIESEL_PROFILE, GASOLINE_PROFILE, PID_ENCODERS, SimulatorEngine, dieselDrivingModel} from '../src/index';
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

describe('engine off at standstill (DefaultDrivingModel option)', () => {
    it('stops the combustion engine while the car stands, every engine-derived signal agreeing', () => {
        let current = 0;
        const model = new DefaultDrivingModel({engineOffAtStandstill: true});
        const car = new SimulatorEngine({profile: SYNTHETIC_GASOLINE_PROFILE, model, now: () => current, seed: 7});
        car.handleCommand('ATE0');
        expect(car.handleCommand('010C')).toBe('410C0000'); // idle phase: engine off
        expect(car.handleCommand('0104')).toBe('410400');
        expect(car.handleCommand('0110')).toBe('41100000');
        expect(car.handleCommand('0166')).toBe('41660300000000');
        expect(car.handleCommand('010B')).toBe('410B65'); // atmospheric, no vacuum
        expect(Number.parseInt(car.handleCommand('0142').slice(4), 16) / 1000).toBeLessThan(13);
        expect(Number.parseFloat(car.handleCommand('ATRV'))).toBeLessThan(13);
        expect(car.handleCommand('015E')).toBe('415E0000');
        current = 60_000;
        expect(Number.parseInt(car.handleCommand('010C').slice(4), 16) / 4).toBeGreaterThan(1000);
        expect(car.handleCommand('ATIGN')).toBe('ON');
    });
});
