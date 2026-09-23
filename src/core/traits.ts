// What differs from one vehicle to the next in the default driving model.
// Pure data, so a recorded vehicle can ship its measured values.

import type {DrivingState} from './drive-cycle';

export interface VehicleTraits {
    /**
     * Engine speed at standstill (synthetic cycle only; a recorded cycle
     * carries its own rpm).
     */
    idleRpm: number;
    /**
     * Coolant at power-on and once warm; the warm-up follows
     * 1 − e^(−t/τ). Oil lags (1.6 τ) and settles `oilOverCoolantC` above.
     */
    coolantStartC: number;
    coolantTargetC: number;
    coolantWarmupTauS: number;
    /**
     * How far above the coolant the warm oil settles.
     */
    oilOverCoolantC: number;
    /**
     * Module voltage (PID 0x42) with the alternator charging.
     */
    chargingVoltage: number;
    /**
     * Long-term fuel trim bank 1 (PID 0x07).
     */
    longTermFuelTrimPct: number;
    /**
     * Intake air temperature (PIDs 0x0F / 0x68).
     */
    intakeTempC: number;
    /**
     * Outdoor temperature (PID 0x46). A recorded vehicle carries the day it
     * was recorded on: its fitted ambient sensor reads `ambientC` at the
     * reference cruise state ({@link AMBIENT_REFERENCE_STATE}) and keeps
     * its heat soak around it; override it to move the drive to another day.
     */
    ambientC: number;
    /**
     * Where the car stands at power-on: odometer (PID 0xA6, the driven
     * distance accumulates on top), fuel level (PID 0x2F, burns down), and
     * the in-use counters since the last code clear (PIDs 0x30 and 0x31;
     * the distance accumulates too). A recorded vehicle takes them from its
     * latest recording.
     */
    odometerKm: number;
    fuelLevelPct: number;
    warmupsSinceClear: number;
    distanceSinceClearKm: number;
}

/**
 * The driving state `ambientC` refers to: a steady cruise, where the ambient
 * sensor is least affected by the engine bay's heat soak.
 */
export const AMBIENT_REFERENCE_STATE: DrivingState = {rpm: 2000, speedKmh: 60, engineLoadPct: 30, throttlePct: 20};

export const DEFAULT_TRAITS: VehicleTraits = {
    idleRpm: 800,
    coolantStartC: 22,
    coolantTargetC: 90,
    coolantWarmupTauS: 150,
    oilOverCoolantC: 8,
    chargingVoltage: 14.1,
    longTermFuelTrimPct: 2,
    intakeTempC: 25,
    ambientC: 22,
    odometerKm: 84_213,
    fuelLevelPct: 62,
    warmupsSinceClear: 42,
    distanceSinceClearKm: 1200,
};

const RANGES: Readonly<Record<keyof VehicleTraits, readonly [number, number]>> = {
    idleRpm: [300, 3000],
    coolantStartC: [-40, 215],
    coolantTargetC: [-40, 215],
    coolantWarmupTauS: [1, 86_400],
    oilOverCoolantC: [-50, 100],
    chargingVoltage: [6, 65],
    longTermFuelTrimPct: [-100, 99.2],
    intakeTempC: [-40, 215],
    ambientC: [-40, 215],
    odometerKm: [0, 429_496_729],
    fuelLevelPct: [0, 100],
    warmupsSinceClear: [0, 255],
    distanceSinceClearKm: [0, 65_535],
};

/**
 * Defaults with the given overrides applied.
 *
 * @throws if an override is not a number within the PID's encodable range.
 */
export function resolveTraits(overrides: Partial<VehicleTraits> = {}): VehicleTraits {
    const traits = {...DEFAULT_TRAITS, ...overrides};
    for (const key of Object.keys(RANGES) as (keyof VehicleTraits)[]) {
        const [min, max] = RANGES[key];
        const value = traits[key];
        if (!Number.isFinite(value) || value < min || value > max) {
            throw new Error(`traits.${key} must be within ${min}..${max}, got ${value}`);
        }
    }
    return traits;
}
