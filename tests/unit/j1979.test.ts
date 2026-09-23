import {describe, expect, it} from 'vitest';
import {PID_ENCODERS, encodeDtc, maskBytesFor, normalizeDtc, toHex} from '../../src/core/j1979';

// The encoder table against the SAE J1979 decode formulas an app would use.
// Each row: PID, physical value, expected data bytes.
const KNOWN_ENCODINGS: readonly [number, number, number[]][] = [
    [0x04, 50, [128]], // load: A × 100/255
    [0x05, 90, [130]], // coolant: A − 40
    [0x06, 0, [128]], // STFT: (A − 128) × 100/128
    [0x06, -100, [0]],
    [0x0c, 800, [0x0c, 0x80]], // rpm: (256A + B)/4
    [0x0d, 90, [90]], // speed
    [0x0e, 8, [144]], // timing advance: A/2 − 64
    [0x10, 12.34, [0x04, 0xd2]], // MAF: (256A + B)/100
    [0x11, 100, [255]],
    [0x14, 0.45, [90, 255]], // O2 voltage: A/200, B = 0xFF (no trim)
    [0x1f, 300, [0x01, 0x2c]], // run time
    [0x21, 1000, [0x03, 0xe8]],
    [0x2f, 62, [158]], // fuel level
    [0x33, 101, [101]], // barometric
    [0x3c, 500, [0x15, 0x18]], // catalyst: (256A + B)/10 − 40
    [0x42, 14.1, [0x37, 0x14]], // module voltage: (256A + B)/1000
    [0x43, 50, [0x00, 0x80]], // absolute load: (256A + B) × 100/255 → 127.5 → 128
    [0x44, 1, [0x80, 0x00]], // commanded λ: (256A + B)/32768, 2 bytes
    [0x46, 22, [62]],
    [0x4d, 120, [0x00, 0x78]],
    [0x5c, 98, [138]],
    [0x5e, 1.5, [0x00, 0x1e]], // fuel rate: (256A + B)/20
    // As recorded from a real car: 4134 8000 8000, 4170 02 0000 0CC2 …, 4171 07 3A 3A 00 00 02, 418B 51 00 …
    [0x34, 1, [0x80, 0x00, 0x80, 0x00]], // λ: (256A + B)/32768, current (256C + D)/256 − 128
    // Pump current follows λ: ≈ 1.1 mA per unit of λ − 1 when lean, 2 mA when rich, 1.3 mA at fuel cut (recorded 4134FFFF814D).
    [0x34, 2, [0xff, 0xff, 0x81, 0x4d]],
    [0x34, 0.9, [0x73, 0x33, 0x7f, 0xcd]],
    [0x34, 1.1, [0x8c, 0xcd, 0x80, 0x1c]],
    [0x65, 1, [0x02, 0x02]], // aux I/O: A advertises the automatic-transmission drive status, B carries it
    [0x65, 0, [0x02, 0x00]],
    [0x6d, 5000, [0x07, 0x01, 0xf4, 0x01, 0xf4, 80, 0, 0, 0, 0, 0]], // fuel pressure control: rail A commanded + actual (10 kPa/bit), fuel temp 40 °C
    [0x9d, 1.5, [0x00, 0x4b, 0x00, 0x4b]], // engine + vehicle fuel rate: 0.02 g/s per bit
    [0x9e, 30, [0x00, 0x96]], // exhaust flow: 0.2 kg/h per bit
    [0x70, 102.0625, [0x02, 0, 0, 0x0c, 0xc2, 0, 0, 0, 0, 0]], // actual boost A: (256D + E) × 0.03125
    [0x71, 22.75, [0x07, 0x3a, 0x3a, 0, 0, 0x02]],
    [0x8b, 0, [0x51, 0, 0, 0, 0, 0, 0]],
    [0x62, -125, [0]], // torque: A − 125
    [0x62, 130, [255]],
    [0x63, 250, [0x00, 0xfa]],
    [0x8e, -12, [113]],
    [0xa6, 84213, [0x00, 0x0c, 0xd9, 0x92]], // odometer: 842130 tenths of km, 4 bytes
];

describe('PID encoders', () => {
    it.each(KNOWN_ENCODINGS)('encodes PID %s value %s per J1979', (pid, value, bytes) => {
        expect(PID_ENCODERS[pid]?.encode(value)).toEqual(bytes);
    });

    it('declares the byte width every encoder actually produces', () => {
        for (const [pid, encoder] of Object.entries(PID_ENCODERS)) {
            for (const value of [-1000, 0, 1, 42, 1000, 1e9]) {
                expect(encoder.encode(value), `PID ${pid} value ${value}`).toHaveLength(encoder.bytes);
            }
        }
    });

    it('clamps out-of-range values into the wire range instead of overflowing', () => {
        for (const [pid, encoder] of Object.entries(PID_ENCODERS)) {
            for (const value of [-1e9, 1e9, 0.5]) {
                for (const byte of encoder.encode(value)) {
                    expect(Number.isInteger(byte) && byte >= 0 && byte <= 255, `PID ${pid} value ${value}`).toBe(true);
                }
            }
        }
    });

    it('is frozen — a test that stubs an encoder cannot poison other engines', () => {
        const table = PID_ENCODERS as Record<number, {encode: unknown}>;
        expect(() => {
            table[0x0d] = {encode: () => [0]};
        }).toThrow();
        expect(() => {
            (table[0x0d] as {encode: unknown}).encode = () => [0];
        }).toThrow();
    });

    it('formats bytes as two upper-case hex digits', () => {
        expect(toHex(0)).toBe('00');
        expect(toHex(10)).toBe('0A');
        expect(toHex(255)).toBe('FF');
    });
});

describe('DTC codec', () => {
    it.each([
        ['P0301', [0x03, 0x01]],
        ['P1234', [0x12, 0x34]],
        ['C0035', [0x40, 0x35]],
        ['B1200', [0x92, 0x00]],
        ['U0100', [0xc1, 0x00]],
        ['P3FFF', [0x3f, 0xff]],
        ['p0420', [0x04, 0x20]],
    ])('encodes %s', (code, bytes) => {
        expect(encodeDtc(code)).toEqual(bytes);
    });

    it.each(['', 'P', 'P030', 'P03011', 'X0301', 'P4000', 'P0GGG', '0301'])('rejects %j', (code) => {
        expect(encodeDtc(code)).toBeNull();
        expect(() => normalizeDtc(code)).toThrow(/invalid DTC/);
    });

    it('normalizes accepted codes', () => {
        expect(normalizeDtc('  u0100 ')).toBe('U0100');
    });
});

describe('support masks', () => {
    it('sets one bit per id in the block, most significant first', () => {
        expect(maskBytesFor(new Set([0x01]), 0x00)).toBe('80000000');
        expect(maskBytesFor(new Set([0x20]), 0x00)).toBe('00000001');
        expect(maskBytesFor(new Set([0x0c, 0x0d]), 0x00)).toBe('00180000');
    });

    it('advertises the next block through the last bit only when needed', () => {
        expect(maskBytesFor(new Set([0x21]), 0x00)).toBe('00000001');
        expect(maskBytesFor(new Set([0x21]), 0x20)).toBe('80000000');
        expect(maskBytesFor(new Set([0x1f]), 0x00)).toBe('00000002');
    });

    it('ignores ids outside the block', () => {
        expect(maskBytesFor(new Set([0x00, 0x45]), 0x20)).toBe('00000001');
        expect(maskBytesFor(new Set(), 0x40)).toBe('00000000');
    });
});
