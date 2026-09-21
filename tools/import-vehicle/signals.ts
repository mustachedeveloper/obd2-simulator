import type {SignalFit, SignalFits} from '../../src/core/signals';
import type {Sample} from './session';

// Fits each recorded channel against the driving state it was seen in:
// value ≈ base + a·load + b·rpm/1000 + c·speed (least squares). Three
// outcomes per channel:
//   - the state explains it (R² above the threshold) → a sloped fit;
//   - it barely moves (reference torque, barometric pressure) → a constant;
//   - neither → no fit: the model's generic formula, which at least follows
//     the drive, beats a frozen value.
// Outliers are cut first — recordings carry sensor glitches (a 655 kPa
// filter pressure, a −100 % fuel trim). The noise is what a sensor adds from
// one reading to the next, NOT the fit's residual: the residual is slow,
// systematic error, and replaying it as jitter would make values jump.

/**
 * AutoPulse channel id → mode 01 PID and its scale. Absent on purpose: what the model
 * replays (rpm, speed, load, throttle, fuel rate) or accumulates, counters
 * (warm-ups), and lambda — two-state (≈1, or 2 during fuel cut), which no
 * straight line describes; the model handles fuel cut itself.
 */
export interface FittedChannel {
    pid: number;
    /**
     * Practical full scale of the signal, in its unit — what "barely moves"
     * is measured against (a relative measure fails for values near zero).
     */
    span: number;
}

export const CHANNELS: Readonly<Record<string, FittedChannel>> = {
    stft1: {pid: 0x06, span: 200},
    ltft1: {pid: 0x07, span: 200},
    intakeMap: {pid: 0x0b, span: 255},
    timingAdvance: {pid: 0x0e, span: 128},
    intakeTemp: {pid: 0x0f, span: 255},
    o2s2Voltage: {pid: 0x15, span: 1.275},
    commandedPurge: {pid: 0x2e, span: 100},
    baro: {pid: 0x33, span: 255},
    moduleVoltage: {pid: 0x42, span: 20},
    absoluteLoad: {pid: 0x43, span: 100},
    relThrottle: {pid: 0x45, span: 100},
    ambientTemp: {pid: 0x46, span: 255},
    throttleB: {pid: 0x47, span: 100},
    pedalPosition: {pid: 0x49, span: 100},
    pedalD: {pid: 0x4a, span: 100},
    throttleActuator: {pid: 0x4c, span: 100},
    absEvapPressure: {pid: 0x53, span: 327},
    stftSecondaryB1: {pid: 0x55, span: 200},
    ltftSecondaryB1: {pid: 0x56, span: 200},
    actualTorque: {pid: 0x62, span: 255},
    referenceTorque: {pid: 0x63, span: 1000},
    iatSensor1: {pid: 0x68, span: 255},
    boostActualA: {pid: 0x70, span: 300},
    vgtActualA: {pid: 0x71, span: 100},
    exhaustPressureB1: {pid: 0x73, span: 255},
    egtB1S1: {pid: 0x78, span: 1000},
    dpfDeltaPressure: {pid: 0x7a, span: 20},
    frictionTorque: {pid: 0x8e, span: 255},
};

export interface FitOptions {
    /**
     * Fewer paired samples than this → a constant.
     */
    minSamples: number;
    /**
     * Share of the variance the state must explain to keep the slopes.
     */
    minRSquared: number;
    /**
     * Share cut from each end of the value distribution before fitting.
     */
    trim: number;
    /**
     * A channel whose middle 80 % covers less than this share of its full
     * scale counts as constant…
     */
    quietShare: number;
    /**
     * …if its whole (trimmed) range also stays below this share: a pedal
     * sampled mostly at rest has a narrow middle but a wide range.
     */
    quietRangeShare: number;
    /**
     * Fewer samples than this prove nothing, not even a constant.
     */
    minConstantSamples: number;
    /**
     * Upper bound of the noise, as a share of the measured range.
     */
    maxNoiseShare: number;
}

export const DEFAULT_FIT_OPTIONS: FitOptions = {
    minSamples: 200,
    minRSquared: 0.5,
    trim: 0.01,
    quietShare: 0.04,
    quietRangeShare: 0.15,
    minConstantSamples: 20,
    maxNoiseShare: 0.02,
};

const SPAN_OF: ReadonlyMap<number, number> = new Map(Object.values(CHANNELS).map((channel) => [channel.pid, channel.span]));

interface Row {
    load: number;
    krpm: number;
    kmh: number;
    value: number;
}

const STATE_CHANNELS = ['engineLoad', 'rpm', 'speed'] as const;
// A state reading older than this no longer describes the moment.
const MAX_STATE_AGE_MS = 2000;
const SIGNIFICANT = 4;

const compact = (value: number): number => Number(value.toPrecision(SIGNIFICANT));

function quantile(sorted: readonly number[], share: number): number {
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(share * (sorted.length - 1))))] ?? 0;
}

// Pairs every sample of a fitted channel with the latest load / rpm / speed.
function rowsOf(samples: readonly Sample[]): Map<number, Row[]> {
    const ordered = [...samples].sort((a, b) => a.t - b.t);
    const latest = new Map<string, Sample>();
    const rows = new Map<number, Row[]>();
    for (const sample of ordered) {
        if ((STATE_CHANNELS as readonly string[]).includes(sample.p)) {
            latest.set(sample.p, sample);
            continue;
        }
        const pid = CHANNELS[sample.p]?.pid;
        const state = STATE_CHANNELS.map((channel) => latest.get(channel));
        const fresh = state.every((reading) => reading !== undefined && sample.t - reading.t <= MAX_STATE_AGE_MS);
        if (pid === undefined || !fresh) continue;
        const [load, rpm, speed] = state;
        const row = {load: load?.v ?? 0, krpm: (rpm?.v ?? 0) / 1000, kmh: speed?.v ?? 0, value: sample.v};
        // Appending in place: a session holds tens of thousands of samples.
        const bucket = rows.get(pid) ?? [];
        bucket.push(row);
        rows.set(pid, bucket);
    }
    return rows;
}

// Solves the 4×4 normal equations (Gauss-Jordan, partial pivoting); null
// when the state never varied enough to separate the slopes.
function leastSquares(rows: readonly Row[]): readonly number[] | null {
    const size = 4;
    const matrix = Array.from({length: size}, () => new Array<number>(size + 1).fill(0));
    for (const row of rows) {
        const x = [1, row.load, row.krpm, row.kmh];
        for (let i = 0; i < size; i++) {
            const target = matrix[i] ?? [];
            for (let j = 0; j < size; j++) target[j] = (target[j] ?? 0) + (x[i] ?? 0) * (x[j] ?? 0);
            target[size] = (target[size] ?? 0) + (x[i] ?? 0) * row.value;
        }
    }
    for (let column = 0; column < size; column++) {
        const pivot = matrix.slice(column).reduce((best, row, offset) => {
            return Math.abs(row[column] ?? 0) > Math.abs(matrix[best]?.[column] ?? 0) ? column + offset : best;
        }, column);
        const pivotRow = matrix[pivot] ?? [];
        if (Math.abs(pivotRow[column] ?? 0) < 1e-9) return null;
        matrix[pivot] = matrix[column] ?? [];
        matrix[column] = pivotRow;
        for (let other = 0; other < size; other++) {
            if (other === column) continue;
            const factor = (matrix[other]?.[column] ?? 0) / (pivotRow[column] ?? 1);
            matrix[other] = (matrix[other] ?? []).map((cell, index) => cell - factor * (pivotRow[index] ?? 0));
        }
    }
    return matrix.map((row, index) => (row[size] ?? 0) / (row[index] ?? 1));
}

// Null unless the channel is quiet enough to be called a constant.
function constantFit(values: readonly number[], min: number, max: number, span: number, options: FitOptions): SignalFit | null {
    const median = quantile(values, 0.5);
    const middle = quantile(values, 0.9) - quantile(values, 0.1);
    const lively = middle > options.quietShare * span || max - min > options.quietRangeShare * span;
    if (values.length < options.minConstantSamples || lively) return null;
    const spread = quantile(
        values.map((value) => Math.abs(value - median)).sort((a, b) => a - b),
        0.5,
    );
    const noise = Math.min(spread, options.maxNoiseShare * (max - min));
    return {
        base: compact(median),
        perLoadPct: 0,
        perKrpm: 0,
        perKmh: 0,
        min: compact(min),
        max: compact(max),
        noise: compact(noise),
    };
}

export interface FitDiagnosis {
    pid: number;
    samples: number;
    /**
     * Share of the variance the driving state explains; null → too few samples to try.
     */
    rSquared: number | null;
    outcome: 'sloped' | 'constant' | 'none';
}

interface Fitted {
    fit: SignalFit | null;
    rSquared: number | null;
    samples: number;
}

function fitOne(all: readonly Row[], span: number, options: FitOptions): Fitted {
    const sorted = all.map((row) => row.value).sort((a, b) => a - b);
    const min = quantile(sorted, options.trim);
    const max = quantile(sorted, 1 - options.trim);
    const rows = all.filter((row) => row.value >= min && row.value <= max);
    const kept = rows.map((row) => row.value).sort((a, b) => a - b);
    const solution = rows.length >= options.minSamples ? leastSquares(rows) : null;
    if (!solution) return {fit: constantFit(kept, min, max, span, options), rSquared: null, samples: rows.length};

    const [base = 0, perLoadPct = 0, perKrpm = 0, perKmh = 0] = solution;
    const predict = (row: Row) => base + perLoadPct * row.load + perKrpm * row.krpm + perKmh * row.kmh;
    const mean = kept.reduce((sum, value) => sum + value, 0) / kept.length;
    const total = rows.reduce((sum, row) => sum + (row.value - mean) ** 2, 0);
    const residual = rows.reduce((sum, row) => sum + (row.value - predict(row)) ** 2, 0);
    const rSquared = total === 0 ? 0 : 1 - residual / total;
    if (rSquared < options.minRSquared) return {fit: constantFit(kept, min, max, span, options), rSquared, samples: rows.length};
    const fit = {
        base: compact(base),
        perLoadPct: compact(perLoadPct),
        perKrpm: compact(perKrpm),
        perKmh: compact(perKmh),
        min: compact(min),
        max: compact(max),
        noise: compact(Math.min(Math.sqrt(residual / rows.length), options.maxNoiseShare * (max - min))),
    };
    return {fit, rSquared, samples: rows.length};
}

export interface SignalFitResult {
    signals: SignalFits;
    /**
     * One line per recorded channel, fitted or not — for the operator.
     */
    diagnosis: readonly FitDiagnosis[];
}

/**
 * A fit per recorded channel that maps to a PID in `pids` — where one is
 * warranted (see the top of this file).
 *
 * @param sessions samples per recording session — pairing never crosses sessions.
 */
export function fitSignals(
    sessions: readonly (readonly Sample[])[],
    pids: readonly number[],
    options: FitOptions = DEFAULT_FIT_OPTIONS,
): SignalFitResult {
    const rows = new Map<number, Row[]>();
    for (const samples of sessions) {
        for (const [pid, sessionRows] of rowsOf(samples)) {
            const bucket = rows.get(pid) ?? [];
            for (const row of sessionRows) bucket.push(row);
            rows.set(pid, bucket);
        }
    }
    const fitted = [...rows.entries()]
        .filter(([pid, pidRows]) => pids.includes(pid) && pidRows.length > 0)
        .sort(([a], [b]) => a - b)
        .map(([pid, pidRows]) => ({pid, ...fitOne(pidRows, SPAN_OF.get(pid) ?? 1, options)}));
    const sloped = (fit: SignalFit) => fit.perLoadPct !== 0 || fit.perKrpm !== 0 || fit.perKmh !== 0;
    return {
        signals: Object.fromEntries(fitted.flatMap(({pid, fit}) => (fit ? [[pid, fit] as const] : []))),
        diagnosis: fitted.map(({pid, fit, rSquared, samples}) => ({
            pid,
            samples,
            rSquared,
            outcome: fit === null ? 'none' : sloped(fit) ? 'sloped' : 'constant',
        })),
    };
}
