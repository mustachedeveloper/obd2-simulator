import {toHex} from './j1979';

// ECU responses → the text an ELM327 prints. With headers off, single-frame
// payloads are one hex line and longer ones use the ISO-TP long form
// ('00A' length line, then 'N:' segments of 6/7 bytes). With headers on
// the adapter cannot reassemble, so raw CAN frames are printed: response id,
// PCI byte(s), data, zero padding to 8 bytes.

export interface EcuResponse {
    ecu: string;
    // Service bytes: [0x41, pid, data...] etc.
    payload: readonly number[];
}

const FRAME_BYTES = 8;
const SINGLE_FRAME_MAX = 7;
const FIRST_FRAME_DATA = 6;
const CONSECUTIVE_FRAME_DATA = 7;

const pad = (bytes: readonly number[]): number[] => [...bytes, ...new Array(FRAME_BYTES - bytes.length).fill(0)];

export function canFrames(payload: readonly number[]): number[][] {
    if (payload.length <= SINGLE_FRAME_MAX) return [pad([payload.length, ...payload])];
    const frames = [pad([0x10, payload.length, ...payload.slice(0, FIRST_FRAME_DATA)])];
    for (let offset = FIRST_FRAME_DATA, sequence = 1; offset < payload.length; offset += CONSECUTIVE_FRAME_DATA, sequence++) {
        frames.push(pad([0x20 | (sequence & 0x0f), ...payload.slice(offset, offset + CONSECUTIVE_FRAME_DATA)]));
    }
    return frames;
}

const hex = (bytes: readonly number[]): string => bytes.map(toHex).join('');

export function isoTpLines(payload: readonly number[]): string[] {
    if (payload.length <= SINGLE_FRAME_MAX) return [hex(payload)];
    const lines = [payload.length.toString(16).toUpperCase().padStart(3, '0')];
    let offset = 0;
    for (let segment = 0; offset < payload.length; segment++) {
        const take = segment === 0 ? FIRST_FRAME_DATA : CONSECUTIVE_FRAME_DATA;
        lines.push(`${(segment % 16).toString(16).toUpperCase()}:${hex(payload.slice(offset, offset + take))}`);
        offset += take;
    }
    return lines;
}

export interface FramingOptions {
    headers: boolean;
    // true → ECU segments arrive round-robin (dirty clone output).
    interleave: boolean;
}

function ecuLines(response: EcuResponse, headers: boolean): string[] {
    if (!headers) return isoTpLines(response.payload);
    return canFrames(response.payload).map((frame) => `${response.ecu}${hex(frame)}`);
}

export function formatResponses(responses: readonly EcuResponse[], options: FramingOptions): string {
    const perEcu = responses.map((response) => ecuLines(response, options.headers));
    if (!options.interleave || perEcu.length < 2) return perEcu.flat().join('\r');
    const depth = Math.max(...perEcu.map((lines) => lines.length));
    const interleaved: string[] = [];
    for (let index = 0; index < depth; index++) {
        for (const lines of perEcu) if (index < lines.length) interleaved.push(lines[index]);
    }
    return interleaved.join('\r');
}

export const hexToBytes = (text: string): number[] => text.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? [];
