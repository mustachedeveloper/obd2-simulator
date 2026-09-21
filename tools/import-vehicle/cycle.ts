import type {DriveCycle} from '../../src/core/drive-cycle';
import type {Sample} from './session';

// Picks one representative stretch of real driving and turns it into a
// DriveCycle: 1 Hz, starting and ending at standstill so the loop closes
// without a jump, with a share of idling and a mean speed close to what the
// vehicle does overall.

type ChannelName = 'speedKmh' | 'rpm' | 'throttlePct' | 'engineLoadPct' | 'fuelRateLph';
export type Series = Readonly<Record<ChannelName, readonly (number | null)[]>>;

export interface CycleOptions {
    /**
     * Length of the loop.
     */
    seconds: number;
    /**
     * The window must reach at least this speed (covers highway driving).
     */
    minTopSpeedKmh: number;
}

const CHANNELS: Readonly<Record<string, ChannelName>> = {
    speed: 'speedKmh',
    rpm: 'rpm',
    throttle: 'throttlePct',
    engineLoad: 'engineLoadPct',
    fuelRate: 'fuelRateLph',
};
const NAMES = Object.values(CHANNELS);
const DECIMALS: Readonly<Record<ChannelName, number>> = {speedKmh: 0, rpm: 0, throttlePct: 1, engineLoadPct: 1, fuelRateLph: 2};
const MAX_GAP_SECONDS = 5;
const TARGET_STANDSTILL_SHARE = 0.2;

const round = (value: number, decimals: number): number => Number(value.toFixed(decimals));

// Per-second means of one channel, short gaps filled with the last value.
function resample(samples: readonly Sample[], startSecond: number, seconds: number): (number | null)[] {
    const sums = new Array<number>(seconds).fill(0);
    const counts = new Array<number>(seconds).fill(0);
    for (const sample of samples) {
        const second = Math.floor(sample.t / 1000) - startSecond;
        sums[second] = (sums[second] ?? 0) + sample.v;
        counts[second] = (counts[second] ?? 0) + 1;
    }
    let last: number | null = null;
    let age = 0;
    return sums.map((sum, second) => {
        const count = counts[second] ?? 0;
        if (count > 0) {
            last = sum / count;
            age = 0;
            return last;
        }
        age++;
        return age <= MAX_GAP_SECONDS ? last : null;
    });
}

export function toSeries(samples: readonly Sample[]): Series {
    const relevant = samples.filter((sample) => sample.p in CHANNELS);
    const times = relevant.map((sample) => Math.floor(sample.t / 1000));
    const start = times.reduce((min, second) => Math.min(min, second), Number.POSITIVE_INFINITY);
    const end = times.reduce((max, second) => Math.max(max, second), Number.NEGATIVE_INFINITY);
    const seconds = relevant.length === 0 ? 0 : end - start + 1;
    const channel = (id: string) =>
        resample(
            relevant.filter((sample) => sample.p === id),
            start,
            seconds,
        );
    return {
        speedKmh: channel('speed'),
        rpm: channel('rpm'),
        throttlePct: channel('throttle'),
        engineLoadPct: channel('engineLoad'),
        fuelRateLph: channel('fuelRate'),
    };
}

interface Candidate {
    series: Series;
    start: number;
    score: number;
}

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);

function overallMeanSpeed(all: readonly Series[]): number {
    return mean(all.flatMap((series) => series.speedKmh.filter((speed): speed is number => speed !== null)));
}

function candidatesOf(series: Series, options: CycleOptions, meanSpeed: number): Candidate[] {
    const {seconds, minTopSpeedKmh} = options;
    const speeds = series.speedKmh;
    const found: Candidate[] = [];
    for (let start = 0; start + seconds <= speeds.length; start++) {
        if (speeds[start] !== 0 || speeds[start + seconds - 1] !== 0) continue;
        const complete = NAMES.every((name) => series[name].slice(start, start + seconds).every((value) => value !== null));
        if (!complete) continue;
        const window = speeds.slice(start, start + seconds) as number[];
        if (Math.max(...window) < minTopSpeedKmh) continue;
        const standstill = window.filter((speed) => speed < 1).length / seconds;
        const score =
            Math.abs(standstill - TARGET_STANDSTILL_SHARE) + Math.abs(mean(window) - meanSpeed) / Math.max(1, meanSpeed);
        found.push({series, start, score});
    }
    return found;
}

/**
 * @throws if no recording holds a complete window that qualifies.
 */
export function buildCycle(all: readonly Series[], options: CycleOptions): DriveCycle {
    const meanSpeed = overallMeanSpeed(all);
    const [best] = all.flatMap((series) => candidatesOf(series, options, meanSpeed)).sort((a, b) => a.score - b.score);
    if (!best) {
        throw new Error(
            `no window of ${options.seconds} s starts and ends at standstill, reaches ${options.minTopSpeedKmh} km/h and has every channel`,
        );
    }
    const cut = (name: ChannelName): number[] =>
        best.series[name].slice(best.start, best.start + options.seconds).map((value) => round(value ?? 0, DECIMALS[name]));
    return {
        stepSeconds: 1,
        speedKmh: cut('speedKmh'),
        rpm: cut('rpm'),
        throttlePct: cut('throttlePct'),
        engineLoadPct: cut('engineLoadPct'),
        fuelRateLph: cut('fuelRateLph'),
    };
}
