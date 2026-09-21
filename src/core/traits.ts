// What differs from one vehicle to the next in the default driving model.
// Pure data, so a recorded vehicle can ship its measured values.

export interface VehicleTraits {
    /**
     * Engine speed at standstill (synthetic cycle only; a recorded cycle
     * carries its own rpm).
     */
    idleRpm: number;
    /**
     * Coolant at power-on and once warm; the warm-up follows
     * 1 − e^(−t/τ). Oil lags (1.6 τ) and settles 8 °C above coolant.
     */
    coolantStartC: number;
    coolantTargetC: number;
    coolantWarmupTauS: number;
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
}

export const DEFAULT_TRAITS: VehicleTraits = {
    idleRpm: 800,
    coolantStartC: 22,
    coolantTargetC: 90,
    coolantWarmupTauS: 150,
    chargingVoltage: 14.1,
    longTermFuelTrimPct: 2,
    intakeTempC: 25,
};

const RANGES: Readonly<Record<keyof VehicleTraits, readonly [number, number]>> = {
    idleRpm: [300, 3000],
    coolantStartC: [-40, 215],
    coolantTargetC: [-40, 215],
    coolantWarmupTauS: [1, 86_400],
    chargingVoltage: [6, 65],
    longTermFuelTrimPct: [-100, 99.2],
    intakeTempC: [-40, 215],
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
