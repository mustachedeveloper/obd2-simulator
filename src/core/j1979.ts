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
const fuelTrim = (value: number): number[] => [Math.round(clamp((value + 100) * 1.28, 0, 255))];
const o2Voltage = (value: number): number[] => [Math.round(clamp(value, 0, 1.275) * 200), 0xff];
const torque = (value: number): number[] => [Math.round(clamp(value, -125, 130)) + 125];
const minutes = (value: number): number[] => word(Math.round(clamp(value, 0, 65535)));
const catTemp = (value: number): number[] => word(Math.round(clamp((value + 40) * 10, 0, 65535)));
// Wide-band lambda (4-byte PIDs): ratio in AB, nominal voltage word in CD.
const lambda = (value: number): number[] => [...word(Math.round(clamp(value, 0, 2) * 32768)), 0x80, 0x00];
const egtWord = (value: number): number[] => word(Math.round(clamp((value + 40) * 10, 0, 65535)));

// Encoders for the PIDs the default simulated vehicles expose. Extending the
// simulator with a new PID = one row here + a driving-model signal. Packet
// PIDs (0x64+) receive ONE primary physical value and synthesize their
// secondary sensor fields from it (a simulator, not a twin).
export const PID_ENCODERS: Readonly<Record<number, PidEncoder>> = {
    0x03: {bytes: 2, encode: (v) => [Math.round(clamp(v, 0, 16)), 0]}, // fuel system status
    0x04: {bytes: 1, encode: pct}, // engine load
    0x05: {bytes: 1, encode: temp}, // coolant temp
    0x06: {bytes: 1, encode: fuelTrim}, // STFT bank 1
    0x07: {bytes: 1, encode: fuelTrim}, // LTFT bank 1
    0x08: {bytes: 1, encode: fuelTrim}, // STFT bank 2
    0x09: {bytes: 1, encode: fuelTrim}, // LTFT bank 2
    0x0a: {bytes: 1, encode: (v) => [Math.round(clamp(v, 0, 765) / 3)]}, // fuel pressure
    0x0b: {bytes: 1, encode: raw1}, // intake MAP
    0x0c: {bytes: 2, encode: (v) => word(Math.round(clamp(v, 0, 16383.75) * 4))}, // rpm
    0x0d: {bytes: 1, encode: raw1}, // speed
    0x0e: {bytes: 1, encode: (v) => [Math.round(clamp((v + 64) * 2, 0, 255))]}, // timing advance
    0x0f: {bytes: 1, encode: temp}, // intake air temp
    0x10: {bytes: 2, encode: (v) => word(Math.round(clamp(v, 0, 655.35) * 100))}, // MAF
    0x11: {bytes: 1, encode: pct}, // throttle
    0x12: {bytes: 1, encode: raw1}, // secondary air status
    0x14: {bytes: 2, encode: o2Voltage}, // O2 S1 voltage
    0x15: {bytes: 2, encode: o2Voltage}, // O2 S2 voltage
    0x1c: {bytes: 1, encode: raw1}, // OBD standard
    0x1e: {bytes: 1, encode: raw1}, // PTO status
    0x1f: {bytes: 2, encode: (v) => word(Math.round(clamp(v, 0, 65535)))}, // run time (s)
    0x21: {bytes: 2, encode: (v) => word(Math.round(clamp(v, 0, 65535)))}, // distance with MIL
    0x22: {bytes: 2, encode: (v) => word(Math.round(clamp(v, 0, 5177) / 0.079))}, // rail gauge
    0x23: {bytes: 2, encode: (v) => word(Math.round(clamp(v, 0, 655350) / 10))}, // rail direct
    0x24: {bytes: 4, encode: lambda}, // O2 S1 lambda
    0x25: {bytes: 4, encode: lambda}, // O2 S2 lambda
    0x2c: {bytes: 1, encode: pct}, // commanded EGR
    0x2d: {bytes: 1, encode: fuelTrim}, // EGR error
    0x2e: {bytes: 1, encode: pct}, // commanded purge
    0x2f: {bytes: 1, encode: pct}, // fuel level
    0x30: {bytes: 1, encode: raw1}, // warm-ups since clear
    0x31: {bytes: 2, encode: (v) => word(Math.round(clamp(v, 0, 65535)))}, // distance since clear
    0x32: {bytes: 2, encode: (v) => word(Math.round(clamp(v, -8192, 8191) * 4) & 0xffff)}, // evap vapor pressure
    0x33: {bytes: 1, encode: raw1}, // barometric pressure
    0x3c: {bytes: 2, encode: catTemp}, // catalyst temp B1S1
    0x3e: {bytes: 2, encode: catTemp}, // catalyst temp B1S2
    0x42: {bytes: 2, encode: (v) => word(Math.round(clamp(v, 0, 65.535) * 1000))}, // module voltage
    0x43: {bytes: 2, encode: (v) => word(Math.round((clamp(v, 0, 200) * 255) / 100))}, // absolute load
    0x44: {bytes: 4, encode: lambda}, // commanded lambda
    0x45: {bytes: 1, encode: pct}, // relative throttle
    0x46: {bytes: 1, encode: temp}, // ambient temp
    0x47: {bytes: 1, encode: pct}, // throttle B
    0x48: {bytes: 1, encode: pct}, // throttle C
    0x49: {bytes: 1, encode: pct}, // pedal D
    0x4a: {bytes: 1, encode: pct}, // pedal D
    0x4b: {bytes: 1, encode: pct}, // pedal E
    0x4c: {bytes: 1, encode: pct}, // throttle actuator
    0x4d: {bytes: 2, encode: minutes}, // time with MIL
    0x4e: {bytes: 2, encode: minutes}, // time since clear
    0x51: {bytes: 1, encode: raw1}, // fuel type
    0x52: {bytes: 1, encode: pct}, // ethanol
    0x53: {bytes: 2, encode: (v) => word(Math.round(clamp(v, 0, 327) * 200))}, // abs evap pressure
    0x54: {bytes: 2, encode: (v) => word(Math.round(clamp(v, -32767, 32768) + 32767))}, // evap wide
    0x55: {bytes: 2, encode: (v) => [...fuelTrim(v), 0x00].slice(0, 2)}, // secondary STFT B1
    0x56: {bytes: 2, encode: (v) => [...fuelTrim(v), 0x00].slice(0, 2)}, // secondary LTFT B1
    0x59: {bytes: 2, encode: (v) => word(Math.round(clamp(v, 0, 655350) / 10))}, // rail abs
    0x5a: {bytes: 1, encode: pct}, // relative pedal
    0x5c: {bytes: 1, encode: temp}, // oil temp
    0x5d: {bytes: 2, encode: (v) => word(Math.round(clamp((v + 210) * 128, 0, 65535)))}, // injection timing
    0x5e: {bytes: 2, encode: (v) => word(Math.round(clamp(v, 0, 3276.75) * 20))}, // fuel rate
    0x61: {bytes: 1, encode: torque}, // demanded torque
    0x62: {bytes: 1, encode: torque}, // actual torque
    0x63: {bytes: 2, encode: (v) => word(Math.round(clamp(v, 0, 65535)))}, // reference torque
    // ── Packet PIDs: byte A is the sensor-support bitmap ─────────────
    0x64: {bytes: 5, encode: (v) => [torque(v)[0], torque(v + 40)[0], torque(v + 70)[0], torque(v + 90)[0], torque(v + 95)[0]]},
    0x66: {bytes: 5, encode: (v) => [0x03, ...word(Math.round(clamp(v, 0, 2047) / 0.03125)), ...word(Math.round((clamp(v, 0, 2047) * 0.98) / 0.03125))]},
    0x67: {bytes: 3, encode: (v) => [0x03, temp(v)[0], temp(v - 2)[0]]},
    0x68: {bytes: 7, encode: (v) => [0x03, temp(v)[0], temp(v + 1)[0], 0, 0, 0, 0]},
    0x69: {bytes: 7, encode: (v) => [0x07, pct(v)[0], pct(v * 0.95)[0], fuelTrim(0)[0], 0, 0, 0]},
    0x6f: {bytes: 3, encode: (v) => [0x01, raw1(v)[0], 0]},
    0x73: {bytes: 5, encode: (v) => [0x01, ...word(Math.round(clamp(v, 0, 655) * 100)), 0, 0]},
    0x74: {bytes: 5, encode: (v) => [0x01, ...word(Math.round(clamp(v, 0, 65535))), 0, 0]},
    0x78: {bytes: 9, encode: (v) => [0x03, ...egtWord(v), ...egtWord(v - 30), 0, 0, 0, 0]},
    0x79: {bytes: 9, encode: (v) => [0x01, ...egtWord(v), 0, 0, 0, 0, 0, 0]},
    0x7a: {bytes: 7, encode: (v) => [0x07, ...word(Math.round(clamp(v, 0, 655) * 100)), ...word(Math.round(clamp(v + 2, 0, 655) * 100)), ...word(Math.round(clamp(2, 0, 655) * 100))]},
    0x7c: {bytes: 9, encode: (v) => [0x03, ...egtWord(v), ...egtWord(v - 60), 0, 0, 0, 0]},
    0x83: {bytes: 5, encode: (v) => [0x03, ...word(Math.round(clamp(v, 0, 65535))), ...word(Math.round(clamp(v * 0.6, 0, 65535)))]},
    0x8e: {bytes: 1, encode: torque}, // friction torque
    0x9b: {bytes: 7, encode: (v) => [0x0f, 82, 65, Math.round((clamp(v, 0, 100) * 255) / 100), 0, 0, 0]}, // DEF: level in byte D
    0xa4: {bytes: 4, encode: (v) => [0x00, 0x01, ...word(Math.round(clamp(v, 0, 65.535) * 1000))]}, // gear ratio in CD
    0xa6: {bytes: 4, encode: (v) => {
        const tenths = Math.round(clamp(v, 0, 429_496_729) * 10);
        return [(tenths >>> 24) & 0xff, (tenths >>> 16) & 0xff, (tenths >>> 8) & 0xff, tenths & 0xff];
    }}, // odometer
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
