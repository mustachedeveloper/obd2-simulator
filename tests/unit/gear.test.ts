import {describe, expect, it} from 'vitest';
import {encodeGearReport, gearFor} from '../../src/core/gear';

describe('gearFor', () => {
    it('is neutral at standstill or with a stopped engine', () => {
        expect(gearFor(930, 0)).toBe(0);
        expect(gearFor(930, 0.9)).toBe(0);
        expect(gearFor(0, 40)).toBe(0);
    });

    it('picks the gear whose rpm-per-km/h is closest', () => {
        expect(gearFor(1251, 8)).toBe(1); // recorded: 156 rpm per km/h
        expect(gearFor(2100, 30)).toBe(2);
        expect(gearFor(1722, 63)).toBe(5); // recorded: 27 rpm per km/h
        expect(gearFor(2000, 120)).toBe(7);
    });

    it('tolerates junk', () => {
        expect(gearFor(Number.NaN, 50)).toBe(0);
        expect(gearFor(2000, Number.NaN)).toBe(0);
    });
});

describe('encodeGearReport', () => {
    it('writes support byte 01 and the gear in the upper nibble of byte B', () => {
        expect(encodeGearReport(0)).toEqual([0x01, 0x00, 0x00, 0x00]);
        expect(encodeGearReport(2)).toEqual([0x01, 0x20, 0x00, 0x00]);
        expect(encodeGearReport(99)).toEqual([0x01, 0xf0, 0x00, 0x00]);
        expect(encodeGearReport(-3)).toEqual([0x01, 0x00, 0x00, 0x00]);
    });
});
