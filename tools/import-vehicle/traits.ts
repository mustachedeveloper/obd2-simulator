import {type SignalFits, evaluateSignal} from '../../src/core/signals';
import {AMBIENT_REFERENCE_STATE, type VehicleTraits, warmupHeat, warmupTauScale} from '../../src/core/traits';
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

// The most recent reading: counters and levels drift, a median would lag.
function latestOf(samples: readonly Sample[], channel: string): number | null {
    const last = samples
        .filter((sample) => sample.p === channel)
        .reduce<Sample | null>((latest, sample) => (latest === null || sample.t >= latest.t ? sample : latest), null);
    return last === null ? null : last.v;
}

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
    /**
     * Brought to the reference heat of `WARMUP_REFERENCE_STATE`.
     */
    tauS: number;
}

// Mean heat (see warmupHeat) the engine produced between two moments, from
// the rpm and load logged per second; null when neither was logged. The
// seconds that hold both give the mean of their products, as the model
// computes it; otherwise the product of the two means stands in.
function meanHeatBetween(samples: readonly Sample[], fromMs: number, toMs: number): number | null {
    const perSecond = new Map<number, {rpm: number[]; load: number[]}>();
    for (const sample of samples) {
        if ((sample.p !== 'rpm' && sample.p !== 'engineLoad') || sample.t < fromMs || sample.t > toMs) continue;
        const second = Math.floor(sample.t / 1000);
        const bucket = perSecond.get(second) ?? {rpm: [], load: []};
        (sample.p === 'rpm' ? bucket.rpm : bucket.load).push(sample.v);
        perSecond.set(second, bucket);
    }
    const buckets = [...perSecond.values()];
    const paired = buckets.filter((bucket) => bucket.rpm.length > 0 && bucket.load.length > 0);
    const meanOf = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
    if (paired.length > 0) {
        return meanOf(
            paired.map((bucket) =>
                warmupHeat({rpm: meanOf(bucket.rpm), engineLoadPct: meanOf(bucket.load), speedKmh: 0, throttlePct: 0}),
            ),
        );
    }
    const rpms = buckets.flatMap((bucket) => bucket.rpm);
    const loads = buckets.flatMap((bucket) => bucket.load);
    if (rpms.length === 0 || loads.length === 0) return null;
    return warmupHeat({rpm: meanOf(rpms), engineLoadPct: meanOf(loads), speedKmh: 0, throttlePct: 0});
}

// A session that began with a cold engine and got one time constant of the
// way; the time that took is brought to the reference heat, so a warm-up
// measured while idling and one measured on the motorway agree.
function coldStartOf(samples: readonly Sample[], targetC: number): ColdStart | null {
    const coolant = samples.filter((sample) => sample.p === 'coolant').sort((a, b) => a.t - b.t);
    const [first] = coolant;
    if (!first || first.v > COLD_START_MAX_C) return null;
    const goal = first.v + (targetC - first.v) * ONE_TAU_SHARE;
    const reached = coolant.find((sample) => sample.v >= goal);
    if (!reached) return null;
    const heat = meanHeatBetween(samples, first.t, reached.t);
    const scale = heat === null ? 1 : warmupTauScale(heat);
    return {startC: first.v, tauS: (reached.t - first.t) / 1000 / scale};
}

/**
 * Start temperature and warm-up time constant from the sessions that began
 * cold, and how far above the coolant the warm oil sits. Sessions that
 * began warm (most do: short stops) say nothing about a warm-up and are
 * ignored; fewer than three cold starts → no verdict. Pass samples that
 * carry rpm and load (the decoded exchanges do): the time constant is
 * normalised to the reference heat, without them it is taken as measured.
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
        ambientC: null,
        odometerKm: rounded(latestOf(samples, 'odometer'), 1),
        fuelLevelPct: rounded(latestOf(samples, 'fuelLevel'), 0),
        warmupsSinceClear: rounded(latestOf(samples, 'warmupsSinceClear'), 0),
        distanceSinceClearKm: rounded(latestOf(samples, 'distanceSinceClear'), 0),
    };
    return Object.fromEntries(Object.entries(measured).filter(([, value]) => value !== null)) as Partial<VehicleTraits>;
}

const noJitter = (): number => 0;

/**
 * The day the vehicle was recorded on: what its fitted ambient sensor reads
 * at the reference cruise state, so the fit replays unchanged by default and
 * `traits.ambientC` can move the drive to another day. Without a fit, the
 * median of the logged ambient temperature.
 */
export function ambientTrait(signals: SignalFits, samples: readonly Sample[]): Partial<VehicleTraits> {
    const fit = signals[0x46];
    const ambientC = rounded(
        fit ? evaluateSignal(fit, AMBIENT_REFERENCE_STATE, noJitter) : median(valuesOf(samples, 'ambientTemp')),
        1,
    );
    return ambientC === null ? {} : {ambientC};
}
