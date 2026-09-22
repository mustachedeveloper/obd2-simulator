import {describe, expect, it} from 'vitest';
import {canFrames, formatLines, hexToBytes, isoTpLines} from '../../src/core/framing';
import {ADDITIONAL_ECU_ID, addressedEcus, ecuHeader, headerText, isExtended} from '../../src/core/ecus';

const bytes = (n: number): number[] => Array.from({length: n}, (_, i) => i + 1);

describe('frame padding', () => {
    const payload = [0x49, 0x04, 0x01, ...Array.from({length: 16}, (_, index) => 0x30 + index)]; // 19 bytes: 6 + 7 + 6

    it('fills the last consecutive frame with the vehicle padding byte', () => {
        expect(isoTpLines(payload, false, 0xaa)).toEqual(['013', '0:490401303132', '1:33343536373839', '2:3A3B3C3D3E3FAA']);
        expect(isoTpLines(payload, true, 0xaa)[3]).toBe('2: 3A 3B 3C 3D 3E 3F AA');
        expect(isoTpLines(payload)).toEqual(['013', '0:490401303132', '1:33343536373839', '2:3A3B3C3D3E3F']);
    });

    it('leaves single frames alone with headers off — the adapter prints PCI-length bytes', () => {
        expect(isoTpLines([0x41, 0x0c, 0x0e, 0x7e], false, 0xaa)).toEqual(['410C0E7E']);
    });

    it('pads raw CAN frames (headers on) with the same byte', () => {
        expect(canFrames([0x41, 0x0c, 0x0e, 0x7e], 0xaa)).toEqual([[0x04, 0x41, 0x0c, 0x0e, 0x7e, 0xaa, 0xaa, 0xaa]]);
        expect(canFrames([0x41, 0x0c, 0x0e, 0x7e])).toEqual([[0x04, 0x41, 0x0c, 0x0e, 0x7e, 0, 0, 0]]);
        expect(canFrames(payload, 0xaa)[2]).toEqual([0x22, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0xaa]);
    });
});

describe('ISO-TP framing', () => {
    it('keeps up to 7 bytes in a single frame, then switches to the long form', () => {
        expect(isoTpLines(bytes(7))).toEqual(['01020304050607']);
        expect(isoTpLines(bytes(8))).toEqual(['008', '0:010203040506', '1:0708']);
        expect(canFrames(bytes(7))).toEqual([[7, 1, 2, 3, 4, 5, 6, 7]]);
        expect(canFrames(bytes(8))).toEqual([
            [0x10, 8, 1, 2, 3, 4, 5, 6],
            [0x21, 7, 8, 0, 0, 0, 0, 0],
        ]);
    });

    it('numbers consecutive frames modulo 16 and pads the last one', () => {
        const frames = canFrames(bytes(6 + 7 * 16 + 3));
        expect(frames).toHaveLength(18);
        expect(frames[1]?.[0]).toBe(0x21);
        expect(frames[16]?.[0]).toBe(0x20);
        expect(frames[17]?.[0]).toBe(0x21);
        expect(frames[17]).toHaveLength(8);
        expect(isoTpLines(bytes(6 + 7 * 16 + 3))[17]).toMatch(/^0:/); // segment index wraps too
    });

    it('prints the length line in three hex digits', () => {
        expect(isoTpLines(bytes(27))[0]).toBe('01B');
        expect(isoTpLines(bytes(300))[0]).toBe('12C');
    });

    it('spaces bytes and the segment prefix under ATS1', () => {
        expect(isoTpLines(bytes(3), true)).toEqual(['01 02 03']);
        expect(isoTpLines(bytes(8), true)).toEqual(['008', '0: 01 02 03 04 05 06', '1: 07 08']);
    });

    it('parses hex pairs and ignores a dangling nibble', () => {
        expect(hexToBytes('410C1AF8')).toEqual([0x41, 0x0c, 0x1a, 0xf8]);
        expect(hexToBytes('')).toEqual([]);
        expect(hexToBytes('ABC')).toEqual([0xab]);
    });
});

describe('formatLines', () => {
    const two = [
        {ecu: '7E8', payload: bytes(8)},
        {ecu: '7E9', payload: bytes(2)},
    ];

    it('prints raw frames with headers, sequential per ECU by default', () => {
        expect(formatLines(two, {headers: true, spaces: false, extended: false, interleave: false})).toEqual([
            '7E81008010203040506',
            '7E82107080000000000',
            '7E90201020000000000',
        ]);
    });

    it('interleaves frames round-robin when asked', () => {
        expect(formatLines(two, {headers: false, spaces: false, extended: false, interleave: true})).toEqual([
            '008',
            '0102',
            '0:010203040506',
            '1:0708',
        ]);
    });

    it('prints 29-bit headers with and without spaces', () => {
        const one = [{ecu: '7E9', payload: [0x41, 0x0c, 0x0e, 0x80]}];
        expect(formatLines(one, {headers: true, spaces: false, extended: true, interleave: false})).toEqual([
            '18DAF11804410C0E80000000',
        ]);
        expect(formatLines(one, {headers: true, spaces: true, extended: true, interleave: false})).toEqual([
            '18 DA F1 18 04 41 0C 0E 80 00 00 00',
        ]);
    });
});

describe('formatLines with a frame budget', () => {
    const options = {headers: false, spaces: false, extended: false, interleave: false};
    const two = [
        {ecu: '7E8', payload: bytes(8)},
        {ecu: '7E9', payload: bytes(2)},
    ];

    it('keeps the length line and only the frames that fit', () => {
        expect(formatLines(two, {...options, maxFrames: 1})).toEqual(['008', '0:010203040506']);
        expect(formatLines(two, {...options, maxFrames: 2})).toEqual(['008', '0:010203040506', '1:0708']);
        expect(formatLines(two, {...options, maxFrames: 3})).toEqual(['008', '0:010203040506', '1:0708', '0102']);
        expect(formatLines(two, {...options, maxFrames: 9})).toEqual(formatLines(two, options));
    });

    it('counts raw frames with headers on', () => {
        expect(formatLines(two, {...options, headers: true, maxFrames: 1})).toEqual(['7E81008010203040506']);
    });

    it('pads a kept last segment only', () => {
        expect(formatLines(two, {...options, padding: 0xaa, maxFrames: 2})).toEqual([
            '008',
            '0:010203040506',
            '1:0708AAAAAAAAAA',
        ]);
    });
});

describe('ECU addressing', () => {
    it('maps 11-bit response ids to 29-bit source addresses in steps of 8', () => {
        expect(ecuHeader('7E8', false)).toBe('7E8');
        expect(ecuHeader('7E8', true)).toBe('18DAF110');
        expect(ecuHeader('7E9', true)).toBe('18DAF118');
        expect(ecuHeader('7EF', true)).toBe('18DAF148');
        expect(headerText('7E9', true, true)).toBe('18 DA F1 18');
        expect(headerText('7E9', false, true)).toBe('7E9');
        expect(isExtended('7')).toBe(true);
        expect(isExtended('6')).toBe(false);
        expect(ADDITIONAL_ECU_ID.test('7E9')).toBe(true);
        expect(ADDITIONAL_ECU_ID.test('7E8')).toBe(false);
    });

    const ids = ['7E8', '7E9', '7EA'];

    it('resolves functional and physical request headers in both widths', () => {
        expect(addressedEcus(ids, {requestHeader: '7DF', receiveFilter: null, extended: false})).toEqual(ids);
        expect(addressedEcus(ids, {requestHeader: '18DB33F1', receiveFilter: null, extended: true})).toEqual(ids);
        expect(addressedEcus(ids, {requestHeader: '7E1', receiveFilter: null, extended: false})).toEqual(['7E9']);
        expect(addressedEcus(ids, {requestHeader: '18DA20F1', receiveFilter: null, extended: true})).toEqual(['7EA']);
        expect(addressedEcus(ids, {requestHeader: '18DA19F1', receiveFilter: null, extended: true})).toEqual([]); // not on the 8-step grid
        expect(addressedEcus(ids, {requestHeader: '7E8', receiveFilter: null, extended: false})).toEqual([]); // a response id
        expect(addressedEcus(ids, {requestHeader: '123', receiveFilter: null, extended: false})).toEqual([]);
    });

    it('applies the receive filter against the printed header', () => {
        expect(addressedEcus(ids, {requestHeader: '7DF', receiveFilter: '7E9', extended: false})).toEqual(['7E9']);
        expect(addressedEcus(ids, {requestHeader: '7DF', receiveFilter: '18DAF118', extended: true})).toEqual(['7E9']);
        expect(addressedEcus(ids, {requestHeader: '7DF', receiveFilter: '7E9', extended: true})).toEqual([]);
    });
});
