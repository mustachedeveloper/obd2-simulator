import {describe, expect, it} from 'vitest';
import {DefaultDrivingModel} from '../../src/core/DefaultDrivingModel';
import type {DriveCycle} from '../../src/core/drive-cycle';
import {mulberry32} from '../../src/core/prng';

const noJitter = () => 0;

// FNV-1a over every PID at a spread of moments, jitter from a fixed seed:
// one number that moves if any default value, or the order in which the
// model draws jitter, ever changes.
function fingerprint(model: DefaultDrivingModel): string {
    const random = mulberry32(11);
    const jitter = (amplitude: number) => (random() * 2 - 1) * amplitude;
    let hash = 0x811c9dc5;
    for (const seconds of [0, 0.5, 7, 19.9, 20, 24, 28, 60, 88, 92, 95.9, 96, 500, 3600, 86_400]) {
        for (let pid = 0; pid <= 0xff; pid++) {
            const value = model.value(pid, seconds, jitter);
            for (const char of `${pid}@${seconds}=${value === null ? 'null' : value.toFixed(6)};`) {
                hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
            }
        }
    }
    return hash.toString(16);
}

describe('DefaultDrivingModel defaults', () => {
    it('are untouched by the traits / drive-cycle options', () => {
        expect(fingerprint(new DefaultDrivingModel())).toBe('ba523393');
        expect(fingerprint(new DefaultDrivingModel({fuelType: 4}))).toBe('bf0b99be');
        expect(fingerprint(new DefaultDrivingModel({engineOffAtStandstill: true}))).toBe('f2666c53');
        expect(fingerprint(new DefaultDrivingModel({traits: {}}))).toBe('ba523393');
    });
});

describe('vehicle traits', () => {
    const model = new DefaultDrivingModel({
        traits: {idleRpm: 930, coolantTargetC: 93, chargingVoltage: 13.9, longTermFuelTrimPct: -5.5, intakeTempC: 42},
    });
    const at = (pid: number, seconds: number) => model.value(pid, seconds, noJitter);

    it('replace the matching defaults', () => {
        expect(at(0x0c, 5)).toBe(930); // idling
        expect(at(0x05, 100_000)).toBeCloseTo(93, 3); // fully warm
        expect(at(0x67, 100_000)).toBeCloseTo(93, 3);
        expect(at(0x5c, 100_000)).toBeCloseTo(101, 3); // oil settles 8 °C above coolant
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
