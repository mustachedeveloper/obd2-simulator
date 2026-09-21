import type {VehicleTraits} from '../../src/core/traits';
import type {Sample} from './session';

// Measured constants of the vehicle: medians over everything it reported,
// so single outliers (sensor glitches, a cold morning) do not matter.

const WARM_COOLANT_C = 70;
const RUNNING_RPM = 300;
const IDLE_RPM_STEP = 10;

function median(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const upper = sorted[middle] ?? 0;
    return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2;
}

const valuesOf = (samples: readonly Sample[], channel: string): number[] =>
    samples.filter((sample) => sample.p === channel).map((sample) => sample.v);

// Engine speed while the last reported vehicle speed was zero.
function idleRpms(samples: readonly Sample[]): number[] {
    const ordered = [...samples].filter((sample) => sample.p === 'speed' || sample.p === 'rpm').sort((a, b) => a.t - b.t);
    let standing = false;
    return ordered.flatMap((sample) => {
        if (sample.p === 'speed') {
            standing = sample.v === 0;
            return [];
        }
        return standing && sample.v > RUNNING_RPM ? [sample.v] : [];
    });
}

const rounded = (value: number | null, decimals: number): number | null =>
    value === null ? null : Number(value.toFixed(decimals));

export function deriveTraits(samples: readonly Sample[]): Partial<VehicleTraits> {
    const idle = median(idleRpms(samples));
    const voltage = median(valuesOf(samples, 'moduleVoltage')) ?? median(valuesOf(samples, 'batteryVoltage'));
    const measured: Readonly<Record<keyof VehicleTraits, number | null>> = {
        idleRpm: idle === null ? null : Math.round(idle / IDLE_RPM_STEP) * IDLE_RPM_STEP,
        coolantStartC: null,
        coolantTargetC: rounded(median(valuesOf(samples, 'coolant').filter((value) => value >= WARM_COOLANT_C)), 0),
        coolantWarmupTauS: null,
        chargingVoltage: rounded(voltage, 1),
        longTermFuelTrimPct: rounded(median(valuesOf(samples, 'ltft1')), 1),
        intakeTempC: rounded(median(valuesOf(samples, 'intakeTemp')), 0),
    };
    return Object.fromEntries(Object.entries(measured).filter(([, value]) => value !== null)) as Partial<VehicleTraits>;
}
