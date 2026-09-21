// A recorded drive: equally spaced samples of the signals everything else
// is derived from, replayed in a loop. Pure data (JSON-compatible), so a
// cycle can be generated from wire logs of a real vehicle and shipped.

export interface DriveCycle {
    /**
     * Spacing of the samples; the loop lasts `stepSeconds × sample count`.
     */
    stepSeconds: number;
    speedKmh: readonly number[];
    rpm: readonly number[];
    throttlePct: readonly number[];
    engineLoadPct: readonly number[];
    /**
     * Fuel rate in L/h. Absent → estimated from load and speed.
     */
    fuelRateLph?: readonly number[];
}

export interface DrivingState {
    speedKmh: number;
    rpm: number;
    throttlePct: number;
    engineLoadPct: number;
}

/**
 * Reads a validated {@link DriveCycle} at any moment: linear interpolation
 * between samples, the last sample leading back into the first.
 */
export interface DriveCyclePlayer {
    stateAt(elapsedSeconds: number): DrivingState;
    /**
     * null → the cycle carries no fuel rate.
     */
    fuelRateAt(elapsedSeconds: number): number | null;
    /**
     * Distance driven since t = 0, integrated over the recorded speed.
     */
    distanceKmAt(elapsedSeconds: number): number;
}

const MIN_SAMPLES = 2;
const SECONDS_PER_HOUR = 3600;

type Channel = 'speedKmh' | 'rpm' | 'throttlePct' | 'engineLoadPct' | 'fuelRateLph';

function validateChannel(name: Channel, samples: readonly number[], expected: number): void {
    if (samples.length !== expected) throw new Error(`drive cycle: ${name} has ${samples.length} samples, expected ${expected}`);
    const bad = samples.findIndex((sample) => !Number.isFinite(sample) || sample < 0);
    if (bad !== -1) throw new Error(`drive cycle: ${name}[${bad}] must be a non-negative number, got ${samples[bad]}`);
}

function validate(cycle: DriveCycle): void {
    if (!Number.isFinite(cycle.stepSeconds) || cycle.stepSeconds <= 0) {
        throw new Error(`drive cycle: stepSeconds must be positive, got ${cycle.stepSeconds}`);
    }
    const count = cycle.speedKmh.length;
    if (count < MIN_SAMPLES) throw new Error(`drive cycle: needs at least ${MIN_SAMPLES} samples, got ${count}`);
    validateChannel('speedKmh', cycle.speedKmh, count);
    validateChannel('rpm', cycle.rpm, count);
    validateChannel('throttlePct', cycle.throttlePct, count);
    validateChannel('engineLoadPct', cycle.engineLoadPct, count);
    if (cycle.fuelRateLph) validateChannel('fuelRateLph', cycle.fuelRateLph, count);
}

// Distance covered when sample i is reached; one extra entry closes the loop.
function cumulativeDistanceKm(speedKmh: readonly number[], stepSeconds: number): readonly number[] {
    // A local running sum: cycles hold hundreds of samples, so no O(n²) copying.
    let total = 0;
    const afterEachSample = speedKmh.map((speed, index) => {
        const next = speedKmh[(index + 1) % speedKmh.length] ?? 0;
        total += (((speed + next) / 2) * stepSeconds) / SECONDS_PER_HOUR;
        return total;
    });
    return [0, ...afterEachSample];
}

/**
 * @throws if the cycle is malformed (unequal channel lengths, fewer than
 * two samples, a non-positive step, negative or non-finite samples).
 */
export function createDriveCyclePlayer(cycle: DriveCycle): DriveCyclePlayer {
    validate(cycle);
    const count = cycle.speedKmh.length;
    const loopSeconds = count * cycle.stepSeconds;
    const distances = cumulativeDistanceKm(cycle.speedKmh, cycle.stepSeconds);
    const loopKm = distances[count] ?? 0;

    // Position in the loop: sample index + progress (0..1) toward the next.
    const locate = (elapsedSeconds: number): readonly [number, number] => {
        const position = (Math.max(0, elapsedSeconds) % loopSeconds) / cycle.stepSeconds;
        const index = Math.min(count - 1, Math.floor(position));
        return [index, position - index];
    };
    const read = (samples: readonly number[], index: number, progress: number): number => {
        const from = samples[index] ?? 0;
        const to = samples[(index + 1) % count] ?? 0;
        return from + (to - from) * progress;
    };

    return {
        stateAt(elapsedSeconds) {
            const [index, progress] = locate(elapsedSeconds);
            return {
                speedKmh: read(cycle.speedKmh, index, progress),
                rpm: read(cycle.rpm, index, progress),
                throttlePct: read(cycle.throttlePct, index, progress),
                engineLoadPct: read(cycle.engineLoadPct, index, progress),
            };
        },
        fuelRateAt(elapsedSeconds) {
            if (!cycle.fuelRateLph) return null;
            const [index, progress] = locate(elapsedSeconds);
            return read(cycle.fuelRateLph, index, progress);
        },
        distanceKmAt(elapsedSeconds) {
            const seconds = Math.max(0, elapsedSeconds);
            const [index, progress] = locate(seconds);
            const from = cycle.speedKmh[index] ?? 0;
            const now = read(cycle.speedKmh, index, progress);
            const partial = (((from + now) / 2) * progress * cycle.stepSeconds) / SECONDS_PER_HOUR;
            return Math.floor(seconds / loopSeconds) * loopKm + (distances[index] ?? 0) + partial;
        },
    };
}
