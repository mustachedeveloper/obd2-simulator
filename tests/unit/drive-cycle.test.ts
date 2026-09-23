import {describe, expect, it} from 'vitest';
import {DefaultDrivingModel} from '../../src/core/DefaultDrivingModel';
import type {DriveCycle} from '../../src/core/drive-cycle';
import {mulberry32} from '../../src/core/prng';

const noJitter = () => 0;

// FNV-1a over every PID at a spread of moments, jitter from a fixed seed:
// one number that moves if any default value, or the order in which the
// model draws jitter, ever changes.
// PIDs the model learned after the fingerprints were taken: hashed as the
// `null` they used to be, so the pinned values keep guarding everything else.
const ADDED_LATER: ReadonlySet<number> = new Set([0x34, 0x65, 0x6d, 0x70, 0x71, 0x8b, 0x9d, 0x9e]);
const UNKNOWN_PID = 0xff;

function fingerprint(model: DefaultDrivingModel): string {
    const random = mulberry32(11);
    const jitter = (amplitude: number) => (random() * 2 - 1) * amplitude;
    let hash = 0x811c9dc5;
    for (const seconds of [0, 0.5, 7, 19.9, 20, 24, 28, 60, 88, 92, 95.9, 96, 500, 3600, 86_400]) {
        for (let pid = 0; pid <= 0xff; pid++) {
            // An unknown PID draws the same driving-state jitter and answers null.
            const value = model.value(ADDED_LATER.has(pid) ? UNKNOWN_PID : pid, seconds, jitter);
            for (const char of `${pid}@${seconds}=${value === null ? 'null' : value.toFixed(6)};`) {
                hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
            }
        }
    }
    return hash.toString(16);
}

describe('DefaultDrivingModel defaults', () => {
    it('are untouched by the traits / drive-cycle options', () => {
        // Re-pinned 2026-09-23 when the warm coolant got its thermostat swing (PIDs 05 / 67).
        expect(fingerprint(new DefaultDrivingModel())).toBe('a18d7a9d');
        expect(fingerprint(new DefaultDrivingModel({fuelType: 4}))).toBe('58db2c6');
        expect(fingerprint(new DefaultDrivingModel({engineOffAtStandstill: true}))).toBe('4b4f9a7f');
        expect(fingerprint(new DefaultDrivingModel({traits: {}}))).toBe('a18d7a9d');
    });
});

describe('vehicle traits', () => {
    const model = new DefaultDrivingModel({
        traits: {
            idleRpm: 930,
            coolantTargetC: 93,
            chargingVoltage: 13.9,
            longTermFuelTrimPct: -5.5,
            intakeTempC: 42,
            oilOverCoolantC: 2,
        },
    });
    const at = (pid: number, seconds: number) => model.value(pid, seconds, noJitter);

    it('replace the matching defaults', () => {
        expect(at(0x0c, 5)).toBe(930); // idling
        // Fully warm; the thermostat runs +4.1 °C over the target for the synthetic cycle's 5-minute mean speed (≈ 63 km/h).
        expect(at(0x05, 100_000)).toBeCloseTo(97.125, 3);
        expect(at(0x67, 100_000)).toBeCloseTo(97.125, 3);
        expect(at(0x5c, 100_000)).toBeCloseTo(95, 3); // oil settles 2 °C above coolant on this car (default 8)
        expect(at(0x42, 5)).toBe(13.9);
        expect(at(0x07, 5)).toBe(-5.5);
        expect(at(0x0f, 5)).toBe(42);
        expect(at(0x68, 5)).toBe(42);
    });

    it('leave everything else at its default', () => {
        const plain = new DefaultDrivingModel();
        for (const pid of [0x0d, 0x11, 0x2f, 0x33, 0x46, 0x63])
            expect(at(pid, 60), `PID ${pid}`).toBe(plain.value(pid, 60, noJitter));
    });

    it('reject nonsense', () => {
        expect(() => new DefaultDrivingModel({traits: {idleRpm: -1}})).toThrow('traits.idleRpm');
        expect(() => new DefaultDrivingModel({traits: {coolantTargetC: Number.NaN}})).toThrow('traits.coolantTargetC');
    });
});

describe('fitted signals', () => {
    const cycle: DriveCycle = {
        stepSeconds: 2,
        speedKmh: [0, 36, 72, 36],
        rpm: [900, 1500, 2100, 1300],
        throttlePct: [12, 40, 30, 14],
        engineLoadPct: [20, 70, 45, 10],
    };
    const signals = {
        // intake MAP: 25 kPa + 0.8 kPa per % load + 2 kPa per 1000 rpm, measured between 20 and 180 kPa
        0x0b: {base: 25, perLoadPct: 0.8, perKrpm: 2, perKmh: 0, min: 20, max: 180, noise: 1.5},
        // ambient temperature: a constant
        0x46: {base: 28, perLoadPct: 0, perKrpm: 0, perKmh: 0, min: 28, max: 28, noise: 0},
        0x0e: {base: 40, perLoadPct: -1, perKrpm: 0, perKmh: 0, min: -10, max: 30, noise: 0},
    };
    const model = new DefaultDrivingModel({cycle, signals});
    const at = (pid: number, seconds: number) => model.value(pid, seconds, noJitter);

    it('compute a PID from the driving state', () => {
        expect(at(0x0b, 0)).toBeCloseTo(25 + 0.8 * 20 + 2 * 0.9, 9);
        expect(at(0x0b, 2)).toBeCloseTo(25 + 0.8 * 70 + 2 * 1.5, 9);
        expect(at(0x46, 5)).toBe(28);
    });

    it('stay within the measured range', () => {
        expect(at(0x0e, 2)).toBe(-10); // 40 - 70 → clamped
        expect(at(0x0e, 6)).toBe(30); // 40 - 10 → exactly the maximum
    });

    it('add noise of the fitted size', () => {
        expect(model.value(0x0b, 0, (amplitude) => amplitude)).toBeCloseTo(25 + 16 + 1.8 + 1.5, 9);
        expect(model.value(0x46, 0, (amplitude) => amplitude)).toBe(28);
    });

    it('never replace what the cycle replays or what accumulates', () => {
        const greedy = new DefaultDrivingModel({cycle, signals: {0x0c: signals[0x46], 0x0d: signals[0x46], 0xa6: signals[0x46]}});
        expect(greedy.value(0x0c, 2, noJitter)).toBe(1500);
        expect(greedy.value(0x0d, 2, noJitter)).toBe(36);
        expect(greedy.value(0xa6, 0, noJitter)).toBeGreaterThan(1000);
    });

    it('yield to the stopped engine of a hybrid', () => {
        const hybrid = new DefaultDrivingModel({cycle, signals, engineOffAtStandstill: true});
        expect(hybrid.value(0x0b, 0, noJitter)).toBe(101); // atmospheric, not the fit
    });

    it('reject a malformed fit', () => {
        const broken = {0x0b: {...signals[0x0b], min: 200}};
        expect(() => new DefaultDrivingModel({signals: broken})).toThrow('signals[0x0b]');
        expect(() => new DefaultDrivingModel({signals: {0x0b: {...signals[0x0b], noise: Number.NaN}}})).toThrow('signals[0x0b]');
    });

    it('leave the defaults untouched when absent or empty', () => {
        expect(fingerprint(new DefaultDrivingModel({signals: {}}))).toBe('a18d7a9d');
    });
});

describe('recorded drive cycle', () => {
    // 4 samples, 2 s apart → an 8 s loop: standstill, 36 km/h, 72 km/h, 36 km/h.
    const cycle: DriveCycle = {
        stepSeconds: 2,
        speedKmh: [0, 36, 72, 36],
        rpm: [900, 1500, 2100, 1300],
        throttlePct: [12, 40, 30, 14],
        engineLoadPct: [20, 70, 45, 10],
    };
    const model = new DefaultDrivingModel({cycle});
    const at = (pid: number, seconds: number) => model.value(pid, seconds, noJitter);

    it('replays the samples', () => {
        expect(at(0x0d, 0)).toBe(0);
        expect(at(0x0d, 2)).toBe(36);
        expect(at(0x0c, 4)).toBe(2100);
        expect(at(0x11, 2)).toBe(40);
        expect(at(0x04, 6)).toBe(10);
    });

    it('interpolates between samples and wraps around the loop', () => {
        expect(at(0x0d, 1)).toBe(18);
        expect(at(0x0c, 3)).toBe(1800);
        expect(at(0x0d, 7)).toBe(18); // last sample → back to the first
        expect(at(0x0d, 8)).toBe(0);
        expect(at(0x0d, 8 * 1000 + 3)).toBe(54);
    });

    it('draws no jitter for the recorded channels — the recording carries its own noise', () => {
        let draws = 0;
        const counting = (amplitude: number) => {
            draws++;
            return amplitude;
        };
        expect(model.value(0x0d, 3, counting)).toBe(54);
        expect(model.value(0x0c, 3, counting)).toBe(1800);
        expect(draws).toBe(0);
    });

    it('derives the other signals from the replayed state', () => {
        const plain = new DefaultDrivingModel();
        // Absolute load follows engine load: 70 % at t = 2.
        expect(at(0x43, 2)).toBeCloseTo(70 * 1.05, 6);
        expect(at(0x43, 2)).not.toBe(plain.value(0x43, 2, noJitter));
        // Gear ratio from rpm per km/h; none at standstill.
        expect(at(0xa4, 0)).toBeNull();
        expect(at(0xa4, 4)).toBeCloseTo(2100 / 72 / 24, 6);
    });

    it('integrates distance over the recorded speed', () => {
        // Trapezoids: (0+36)/2 + (36+72)/2 + (72+36)/2 + (36+0)/2 = 144 km/h·2 s = 0.08 km per loop.
        const odometer = (seconds: number) => (at(0xa6, seconds) ?? 0) - (at(0xa6, 0) ?? 0);
        expect(odometer(8)).toBeCloseTo(0.08, 9);
        expect(odometer(2)).toBeCloseTo(0.01, 9);
        expect(odometer(8 * 50 + 2)).toBeCloseTo(0.08 * 50 + 0.01, 9);
        expect((at(0x31, 8) ?? 0) - (at(0x31, 0) ?? 0)).toBeCloseTo(0.08, 9);
    });

    it('uses the recorded fuel rate when the cycle has one', () => {
        const withFuel = new DefaultDrivingModel({cycle: {...cycle, fuelRateLph: [0.8, 6, 4, 0]}});
        expect(withFuel.value(0x5e, 2, noJitter)).toBe(6);
        expect(withFuel.value(0x5e, 5, noJitter)).toBe(2);
        // Without one it is estimated from load and speed, as before.
        expect(at(0x5e, 2)).toBeCloseTo(0.5 + 70 * 0.12 + 36 * 0.04, 6);
    });

    it('reads full lean on the lambda PIDs during fuel cut: rolling with zero engine load', () => {
        // In the recordings load = 0 marks 90 % of the lean readings (1.5 % false alarms); the
        // fuel-rate PID lags and marks only 60 %, so it plays no part.
        const overrun = new DefaultDrivingModel({cycle: {...cycle, engineLoadPct: [20, 70, 0, 0], fuelRateLph: [0.8, 6, 3, 0]}});
        for (const pid of [0x24, 0x34, 0x44]) {
            expect(overrun.value(pid, 2, noJitter), `PID ${pid}`).toBe(1); // under load
            expect(overrun.value(pid, 4, noJitter), `PID ${pid}`).toBeCloseTo(2, 4); // rolling, no load — whatever the fuel PID says
            expect(overrun.value(pid, 3, noJitter), `PID ${pid}`).toBe(1); // load still 35 % between the samples
        }
        // Zero load while standing still (engine stopped or idling) is not overrun.
        const standing = new DefaultDrivingModel({cycle: {...cycle, engineLoadPct: [0, 70, 45, 10]}});
        expect(standing.value(0x44, 0, noJitter)).toBe(1);
        // A recorded zero fuel rate alone does not make a fuel cut.
        const lagging = new DefaultDrivingModel({cycle: {...cycle, fuelRateLph: [0.8, 6, 0, 0]}});
        expect(lagging.value(0x44, 4, noJitter)).toBe(1);
    });

    it('stops the engine at standstill for hybrids', () => {
        const hybrid = new DefaultDrivingModel({cycle, engineOffAtStandstill: true});
        expect(hybrid.value(0x0c, 0, noJitter)).toBe(0);
        expect(hybrid.value(0x0c, 2, noJitter)).toBe(1500);
    });

    it('rejects a malformed cycle', () => {
        expect(() => new DefaultDrivingModel({cycle: {...cycle, stepSeconds: 0}})).toThrow('stepSeconds');
        expect(() => new DefaultDrivingModel({cycle: {...cycle, rpm: [900, 1500]}})).toThrow('rpm has 2 samples, expected 4');
        expect(() => new DefaultDrivingModel({cycle: {...cycle, fuelRateLph: [1]}})).toThrow(
            'fuelRateLph has 1 samples, expected 4',
        );
        expect(() => new DefaultDrivingModel({cycle: {...cycle, speedKmh: [0, 36, Number.NaN, 36]}})).toThrow('speedKmh[2]');
        const empty = {stepSeconds: 1, speedKmh: [], rpm: [], throttlePct: [], engineLoadPct: []};
        expect(() => new DefaultDrivingModel({cycle: empty})).toThrow('at least 2 samples');
    });
});
