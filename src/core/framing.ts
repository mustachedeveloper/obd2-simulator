import {toHex} from './j1979';
import {headerText, type SourceAddresses} from './ecus';

// ECU responses → the text an ELM327 prints. With headers off, single-frame
// payloads are one hex line and longer ones use the ISO-TP long form
// ('00A' length line, then 'N:' segments of 6/7 bytes). With headers on
// the adapter cannot reassemble, so raw CAN frames are printed: response id,
// PCI byte(s), data, padding to 8 bytes. ATS1 puts a space between every
// printed byte (and after the 'N:' segment prefix).
//
// Vehicles that fill unused frame bytes (commonly with AA) show it in both
// forms: the raw frames carry the byte, and with headers off the adapter
// prints a consecutive frame whole, so the LAST segment ends in padding —
// single frames are printed by their PCI length and stay clean.

export interface EcuResponse {
    // 11-bit response id of the ECU ('7E8').
    ecu: string;
    // Service bytes: [0x41, pid, data...] etc.
    payload: readonly number[];
}

const FRAME_BYTES = 8;
const SINGLE_FRAME_MAX = 7;
const FIRST_FRAME_DATA = 6;
const CONSECUTIVE_FRAME_DATA = 7;

const filled = (bytes: readonly number[], length: number, padding: number): number[] => [
    ...bytes,
    ...new Array(Math.max(0, length - bytes.length)).fill(padding),
];

export function canFrames(payload: readonly number[], padding = 0): number[][] {
    const pad = (bytes: readonly number[]): number[] => filled(bytes, FRAME_BYTES, padding);
    if (payload.length <= SINGLE_FRAME_MAX) return [pad([payload.length, ...payload])];
    const frames = [pad([0x10, payload.length, ...payload.slice(0, FIRST_FRAME_DATA)])];
    for (let offset = FIRST_FRAME_DATA, sequence = 1; offset < payload.length; offset += CONSECUTIVE_FRAME_DATA, sequence++) {
        frames.push(pad([0x20 | (sequence & 0x0f), ...payload.slice(offset, offset + CONSECUTIVE_FRAME_DATA)]));
    }
    return frames;
}

const hex = (bytes: readonly number[], spaces: boolean): string => bytes.map(toHex).join(spaces ? ' ' : '');

/**
 * @param padding fills the last segment to a whole consecutive frame; undefined → printed as long as the payload.
 * @param padSingle a single frame is printed whole as well, padding included (needs `padding`).
 */
export function isoTpLines(payload: readonly number[], spaces = false, padding?: number, padSingle = false): string[] {
    if (payload.length <= SINGLE_FRAME_MAX) {
        return [hex(padSingle && padding !== undefined ? filled(payload, SINGLE_FRAME_MAX, padding) : payload, spaces)];
    }
    const lines = [payload.length.toString(16).toUpperCase().padStart(3, '0')];
    let offset = 0;
    for (let segment = 0; offset < payload.length; segment++) {
        const take = segment === 0 ? FIRST_FRAME_DATA : CONSECUTIVE_FRAME_DATA;
        const data = payload.slice(offset, offset + take);
        const printed = padding === undefined || segment === 0 ? data : filled(data, take, padding);
        lines.push(`${(segment % 16).toString(16).toUpperCase()}:${spaces ? ' ' : ''}${hex(printed, spaces)}`);
        offset += take;
    }
    return lines;
}

export interface FramingOptions {
    headers: boolean;
    spaces: boolean;
    // 29-bit CAN ids (ISO 15765-4 CAN 29/xxx).
    extended: boolean;
    // true → ECU segments arrive round-robin (dirty clone output).
    interleave: boolean;
    // Byte the vehicle fills unused frame bytes with; undefined → none.
    padding?: number;
    // true → the adapter cuts the last segment to the payload (headers off only).
    trimSegments?: boolean;
    // The adapter stops listening after this many CAN frames (a frame-counting
    // response hint): later frames and ECUs are never printed.
    maxFrames?: number;
    // true → single frames are printed whole, padding included (headers off only).
    padSingleFrames?: boolean;
    // true → a raw single frame ends at its PCI length (headers on only).
    trimRawSingleFrames?: boolean;
    // Declared 29-bit source addresses by ECU id.
    sources?: SourceAddresses;
}

function ecuLines(response: EcuResponse, options: FramingOptions): string[] {
    if (!options.headers) {
        const padding = options.trimSegments ? undefined : options.padding;
        return isoTpLines(response.payload, options.spaces, padding, options.padSingleFrames === true);
    }
    const header = headerText(response.ecu, options.extended, options.spaces, options.sources);
    const single = response.payload.length <= SINGLE_FRAME_MAX;
    const frames =
        single && options.trimRawSingleFrames
            ? [[response.payload.length, ...response.payload]]
            : canFrames(response.payload, options.padding);
    return frames.map((frame) => `${header}${options.spaces ? ' ' : ''}${hex(frame, options.spaces)}`);
}

// With headers off a multi-frame answer prints one line more than it has
// frames (the length line), which does not count against the budget.
function withinBudget(lines: readonly string[], frames: number, headers: boolean): string[] {
    const extra = !headers && lines.length > 1 ? 1 : 0;
    return lines.slice(0, frames + extra);
}

function budgeted(perEcu: readonly string[][], responses: readonly EcuResponse[], options: FramingOptions): string[][] {
    if (options.maxFrames === undefined) return [...perEcu];
    let left = options.maxFrames;
    return perEcu.flatMap((lines, index) => {
        const frames = Math.min(left, canFrames(responses[index]?.payload ?? []).length);
        left -= frames;
        return frames > 0 ? [withinBudget(lines, frames, options.headers)] : [];
    });
}

export function formatLines(responses: readonly EcuResponse[], options: FramingOptions): string[] {
    const perEcu = budgeted(
        responses.map((response) => ecuLines(response, options)),
        responses,
        options,
    );
    if (!options.interleave || perEcu.length < 2) return perEcu.flat();
    const depth = Math.max(...perEcu.map((lines) => lines.length));
    const interleaved: string[] = [];
    for (let index = 0; index < depth; index++) {
        for (const lines of perEcu) {
            const line = lines[index];
            if (line !== undefined) interleaved.push(line);
        }
    }
    return interleaved;
}

export const hexToBytes = (text: string): number[] => text.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? [];
