import type {DrivingState} from './drive-cycle';

// A signal fitted to recordings of a real vehicle: how one PID follows the
// driving state. Pure data — a recorded vehicle ships one fit per PID it
// was seen reporting, and the model evaluates them instead of its generic
// formulas. A constant is a fit with every slope at zero.

export interface SignalFit {
    /**
     * Value with the engine at zero load, zero rpm, standing still.
     */
    base: number;
    perLoadPct: number;
    /**
     * Per 1000 rpm.
     */
    perKrpm: number;
    perKmh: number;
    /**
     * The range the vehicle was seen reporting; results are kept inside it.
     */
    min: number;
    max: number;
    /**
     * Amplitude of the jitter added on top (what the fit does not explain).
     */
    noise: number;
}

/**
 * PID → fit.
 */
export type SignalFits = Readonly<Record<number, SignalFit>>;

// What the model replays or accumulates itself and no fit may replace: the
// cycle's own channels, run time, distances, timers, fuel level, odometer.
const RESERVED_PIDS: ReadonlySet<number> = new Set([
    0x04, 0x0c, 0x0d, 0x11, 0x1f, 0x21, 0x2f, 0x31, 0x4d, 0x4e, 0x51, 0x5e, 0xa6,
]);

const FIELDS: readonly (keyof SignalFit)[] = ['base', 'perLoadPct', 'perKrpm', 'perKmh', 'min', 'max', 'noise'];

/**
 * The usable fits of `signals`: validated, reserved PIDs dropped.
 *
 * @throws if a fit has a non-finite field, a negative noise or min > max.
 */
export function resolveSignals(signals: SignalFits = {}): ReadonlyMap<number, SignalFit> {
    const entries = Object.entries(signals).map(([key, fit]) => [Number(key), fit] as const);
    for (const [pid, fit] of entries) {
        const broken = FIELDS.some((field) => !Number.isFinite(fit[field])) || fit.noise < 0 || fit.min > fit.max;
        if (broken) throw new Error(`signals[0x${pid.toString(16).padStart(2, '0')}] is malformed: ${JSON.stringify(fit)}`);
    }
    return new Map(entries.filter(([pid]) => !RESERVED_PIDS.has(pid)));
}

export function evaluateSignal(fit: SignalFit, state: DrivingState, jitter: (amplitude: number) => number): number {
    const value =
        fit.base + fit.perLoadPct * state.engineLoadPct + (fit.perKrpm * state.rpm) / 1000 + fit.perKmh * state.speedKmh;
    const noisy = fit.noise > 0 ? value + jitter(fit.noise) : value;
    return Math.min(fit.max, Math.max(fit.min, noisy));
}
