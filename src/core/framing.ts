import {toHex} from './j1979';
import {headerText} from './ecus';

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
 */
export function isoTpLines(payload: readonly number[], spaces = false, padding?: number): string[] {
    if (payload.length <= SINGLE_FRAME_MAX) return [hex(payload, spaces)];
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
}

function ecuLines(response: EcuResponse, options: FramingOptions): string[] {
    if (!options.headers) return isoTpLines(response.payload, options.spaces, options.trimSegments ? undefined : options.padding);
    const header = headerText(response.ecu, options.extended, options.spaces);
    return canFrames(response.payload, options.padding).map(
        (frame) => `${header}${options.spaces ? ' ' : ''}${hex(frame, options.spaces)}`,
    );
}

export function formatLines(responses: readonly EcuResponse[], options: FramingOptions): string[] {
    const perEcu = responses.map((response) => ecuLines(response, options));
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
