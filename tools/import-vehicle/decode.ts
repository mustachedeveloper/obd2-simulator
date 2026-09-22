import {PID_ENCODERS} from '../../src/core/j1979';
import {ecuPayloads, requestOf} from './responses';
import type {Exchange, Sample} from './session';
import {CHANNELS} from './signals';

// Mode 01 answers of the engine ECU, decoded into the same samples the app
// logs — the app decodes only the channels it displays, and polls most
// secondary PIDs a handful of times; the raw exchanges hold every answer.
// Batch responses are walked with the encoders' byte counts.

type Decoder = (bytes: readonly number[]) => number;

const word = (bytes: readonly number[], at: number): number => (bytes[at] ?? 0) * 256 + (bytes[at + 1] ?? 0);
const temp = (bytes: readonly number[], at = 0): number => (bytes[at] ?? 0) - 40;
const pct = (bytes: readonly number[], at = 0): number => ((bytes[at] ?? 0) * 100) / 255;
const trim = (bytes: readonly number[]): number => (bytes[0] ?? 0) / 1.28 - 100;
const torque = (bytes: readonly number[]): number => (bytes[0] ?? 0) - 125;

/**
 * Physical value of the data bytes, per PID — the inverse of PID_ENCODERS
 * for the channels the importer fits (first sensor of multi-sensor PIDs).
 */
export const DECODERS: Readonly<Record<number, Decoder>> = {
    0x04: pct,
    0x0c: (b) => word(b, 0) / 4,
    0x0d: (b) => b[0] ?? 0,
    0x06: trim,
    0x07: trim,
    0x0b: (b) => b[0] ?? 0,
    0x0e: (b) => (b[0] ?? 0) / 2 - 64,
    0x0f: temp,
    0x15: (b) => (b[0] ?? 0) / 200,
    0x2e: pct,
    0x33: (b) => b[0] ?? 0,
    0x3c: (b) => word(b, 0) / 10 - 40,
    0x42: (b) => word(b, 0) / 1000,
    0x43: (b) => (word(b, 0) * 100) / 255,
    0x45: pct,
    0x46: temp,
    0x47: pct,
    0x49: pct,
    0x4a: pct,
    0x4c: pct,
    0x53: (b) => word(b, 0) / 200,
    0x55: trim,
    0x56: trim,
    0x62: torque,
    0x63: (b) => word(b, 0),
    0x68: (b) => temp(b, 1),
    0x70: (b) => word(b, 3) * 0.03125,
    0x71: (b) => pct(b, 1),
    0x73: (b) => word(b, 1) / 100,
    0x78: (b) => word(b, 1) / 10 - 40,
    0x7a: (b) => word(b, 1) / 100,
    0x8e: torque,
};

// The driving state the fits are made against comes from the same answers:
// the app logs it only for channels on display, the ECU answers every poll.
const STATE_PIDS: Readonly<Record<number, string>> = {0x04: 'engineLoad', 0x0c: 'rpm', 0x0d: 'speed'};
const CHANNEL_OF: ReadonlyMap<number, string> = new Map([
    ...Object.entries(CHANNELS).map(([id, channel]) => [channel.pid, id] as const),
    ...Object.entries(STATE_PIDS).map(([pid, id]) => [Number(pid), id] as const),
]);
const isPadding = (tail: readonly number[]): boolean => tail.every((byte) => byte === tail[0]);
const bytesOf = (hex: string): number[] => hex.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? [];

/**
 * Samples decoded from one mode 01 answer of the engine ECU (the first
 * responder), or none when the payload cannot be walked to its end.
 */
export function decodeMode01(exchange: Exchange): Sample[] {
    const request = requestOf(exchange.c);
    if (!request.startsWith('01') || request.length < 4) return [];
    const [payload] = ecuPayloads(exchange.c, exchange.r);
    if (!payload?.startsWith('41')) return [];
    const bytes = bytesOf(payload.slice(2));
    const samples: Sample[] = [];
    for (let at = 0; at < bytes.length; ) {
        const pid = bytes[at] ?? 0;
        const length = PID_ENCODERS[pid]?.bytes;
        // Some clones print a single frame whole: the tail is padding.
        if (length === undefined) return isPadding(bytes.slice(at)) ? samples : [];
        const data = bytes.slice(at + 1, at + 1 + length);
        const channel = CHANNEL_OF.get(pid);
        const decode = DECODERS[pid];
        if (channel !== undefined && decode !== undefined && data.length === length) {
            samples.push({t: exchange.t, p: channel, v: decode(data)});
        }
        at += 1 + length;
    }
    return samples;
}

/**
 * The session's samples with the fitted channels and the driving state
 * taken from the raw exchanges instead of the app's decoding; channels the
 * exchanges never answered stay as logged.
 */
export function withDecodedSamples(samples: readonly Sample[], exchanges: readonly Exchange[]): Sample[] {
    const decoded = exchanges.flatMap(decodeMode01);
    const covered = new Set(decoded.map((sample) => sample.p));
    return [...samples.filter((sample) => !covered.has(sample.p)), ...decoded];
}
