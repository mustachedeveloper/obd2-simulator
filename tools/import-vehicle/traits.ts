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

const COLD_START_MAX_C = 60;
const MIN_COLD_STARTS = 3;
const WARM_OIL_AFTER_S = 900;
// 1 − 1/e: the share of the way to the target reached after one time constant.
const ONE_TAU_SHARE = 0.632;

interface ColdStart {
    startC: number;
    tauS: number;
}

// A session that began with a cold engine and got one time constant of the way.
function coldStartOf(samples: readonly Sample[], targetC: number): ColdStart | null {
    const coolant = samples.filter((sample) => sample.p === 'coolant').sort((a, b) => a.t - b.t);
    const [first] = coolant;
    if (!first || first.v > COLD_START_MAX_C) return null;
    const goal = first.v + (targetC - first.v) * ONE_TAU_SHARE;
    const reached = coolant.find((sample) => sample.v >= goal);
    return reached ? {startC: first.v, tauS: (reached.t - first.t) / 1000} : null;
}

/**
 * Start temperature and warm-up time constant from the sessions that began
 * cold, and how far above the coolant the warm oil sits. Sessions that
 * began warm (most do: short stops) say nothing about a warm-up and are
 * ignored; fewer than three cold starts → no verdict.
 */
export function deriveWarmup(sessions: readonly (readonly Sample[])[], coolantTargetC: number): Partial<VehicleTraits> {
    const cold = sessions
        .map((samples) => coldStartOf(samples, coolantTargetC))
        .filter((start): start is ColdStart => start !== null);
    const warmOil = sessions.flatMap((samples) => {
        const startedAt = samples.reduce((min, sample) => Math.min(min, sample.t), Number.POSITIVE_INFINITY);
        return samples
            .filter((sample) => sample.p === 'oilTemp' && sample.t - startedAt >= WARM_OIL_AFTER_S * 1000)
            .map((sample) => sample.v);
    });
    const oil = median(warmOil);
    const enough = cold.length >= MIN_COLD_STARTS;
    const measured = {
        coolantStartC: enough ? rounded(median(cold.map((start) => start.startC)), 0) : null,
        coolantWarmupTauS: enough ? rounded(median(cold.map((start) => start.tauS)), 0) : null,
        oilOverCoolantC: oil === null ? null : rounded(oil - coolantTargetC, 0),
    };
    return Object.fromEntries(Object.entries(measured).filter(([, value]) => value !== null)) as Partial<VehicleTraits>;
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
        oilOverCoolantC: null,
        chargingVoltage: rounded(voltage, 1),
        longTermFuelTrimPct: rounded(median(valuesOf(samples, 'ltft1')), 1),
        intakeTempC: rounded(median(valuesOf(samples, 'intakeTemp')), 0),
    };
    return Object.fromEntries(Object.entries(measured).filter(([, value]) => value !== null)) as Partial<VehicleTraits>;
}
