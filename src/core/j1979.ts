// SAE J1979 wire encoding: physical value → mode 01 data bytes, DTC codec
// and the ELM327 output framing helpers. This is the simulator's own table —
// consumers decode with their own; round-tripping the two validates both.

export const toHex = (byte: number): string => byte.toString(16).toUpperCase().padStart(2, '0');

export const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const word = (value: number): number[] => [Math.floor(value / 256) & 0xff, value & 0xff];

export interface PidEncoder {
    bytes: number;
    encode: (value: number) => number[];
}

const pct = (value: number): number[] => [Math.round((clamp(value, 0, 100) * 255) / 100)];
const temp = (value: number): number[] => [Math.round(clamp(value, -40, 215)) + 40];
const raw1 = (value: number): number[] => [Math.round(clamp(value, 0, 255))];

// Encoders for the PIDs the default simulated vehicles expose. Extending the
// simulator with a new PID = one row here + a driving-model signal.
export const PID_ENCODERS: Readonly<Record<number, PidEncoder>> = {
    0x04: {bytes: 1, encode: pct}, // engine load
    0x05: {bytes: 1, encode: temp}, // coolant temp
    0x06: {bytes: 1, encode: (v) => [Math.round(clamp((v + 100) * 1.28, 0, 255))]}, // STFT bank 1
    0x0b: {bytes: 1, encode: raw1}, // intake MAP
    0x0c: {bytes: 2, encode: (v) => word(Math.round(clamp(v, 0, 16383.75) * 4))}, // rpm
    0x0d: {bytes: 1, encode: raw1}, // speed
    0x0e: {bytes: 1, encode: (v) => [Math.round(clamp((v + 64) * 2, 0, 255))]}, // timing advance
    0x0f: {bytes: 1, encode: temp}, // intake air temp
    0x10: {bytes: 2, encode: (v) => word(Math.round(clamp(v, 0, 655.35) * 100))}, // MAF
    0x11: {bytes: 1, encode: pct}, // throttle
    0x14: {bytes: 2, encode: (v) => [Math.round(clamp(v, 0, 1.275) * 200), 0xff]}, // O2 S1 voltage
    0x2f: {bytes: 1, encode: pct}, // fuel level
    0x33: {bytes: 1, encode: raw1}, // barometric pressure
    0x42: {bytes: 2, encode: (v) => word(Math.round(clamp(v, 0, 65.535) * 1000))}, // module voltage
    0x46: {bytes: 1, encode: temp}, // ambient temp
    0x51: {bytes: 1, encode: raw1}, // fuel type
    0x5c: {bytes: 1, encode: temp}, // oil temp
    0x62: {bytes: 1, encode: (v) => [Math.round(clamp(v, -125, 130)) + 125]}, // actual torque
};

const DTC_SYSTEM_LETTERS = ['P', 'C', 'B', 'U'] as const;

// 'P0301' → the two wire bytes, or null for malformed codes.
export function encodeDtc(code: string): [number, number] | null {
    const match = /^([PCBU])([0-3])([0-9A-F]{3})$/i.exec(code.trim());
    if (!match) return null;
    const system = DTC_SYSTEM_LETTERS.indexOf(match[1].toUpperCase() as (typeof DTC_SYSTEM_LETTERS)[number]);
    const firstDigit = Number.parseInt(match[2], 10);
    const remaining = Number.parseInt(match[3], 16);
    return [(system << 6) | (firstDigit << 4) | (remaining >> 8), remaining & 0xff];
}

// Builds the 4-byte support-mask hex for one base block (0x00, 0x20, ...)
// from a set of ids; the last bit advertises the next block when needed.
export function maskBytesFor(ids: ReadonlySet<number>, baseId: number): string {
    const maskBytes = [0, 0, 0, 0];
    for (const id of ids) {
        if (id > baseId && id <= baseId + 0x20) {
            const offset = id - baseId - 1;
            maskBytes[Math.floor(offset / 8)] |= 0x80 >> (offset % 8);
        }
    }
    if ([...ids].some((id) => id > baseId + 0x20)) {
        maskBytes[3] |= 0x01;
    }
    return maskBytes.map(toHex).join('');
}

export const asciiBytes = (text: string): number[] => [...text].map((ch) => ch.charCodeAt(0));

// Formats a payload the way an ELM327 prints it with spaces off: a single
// hex line when it fits one CAN frame (≤7 bytes), otherwise the ISO-TP long
// form — 3-digit length line, then 'N:'-prefixed segments (6 bytes first,
// 7 thereafter).
export function isoTpResponse(payload: readonly number[]): string {
    const hex = payload.map(toHex).join('');
    if (payload.length <= 7) return hex;
    const lines = [payload.length.toString(16).toUpperCase().padStart(3, '0')];
    let offset = 0;
    for (let frame = 0; offset < hex.length; frame++) {
        const take = (frame === 0 ? 6 : 7) * 2;
        lines.push(`${(frame % 16).toString(16).toUpperCase()}:${hex.slice(offset, offset + take)}`);
        offset += take;
    }
    return lines.join('\r');
}
