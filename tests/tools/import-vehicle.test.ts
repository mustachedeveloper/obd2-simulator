import {describe, expect, it} from 'vitest';
import {assertNoLeak, syntheticVin} from '../../tools/import-vehicle/anonymize';
import {buildCycle, toSeries} from '../../tools/import-vehicle/cycle';
import {buildIdentity} from '../../tools/import-vehicle/identity';
import {ecuPayloads} from '../../tools/import-vehicle/responses';
import {deriveTraits} from '../../tools/import-vehicle/traits';
import type {Exchange, Sample} from '../../tools/import-vehicle/session';

describe('ecuPayloads', () => {
    it('reads single-frame lines, one per ECU', () => {
        expect(ecuPayloads('0100', '4100BE3EA813\r4100981A0001\r\r')).toEqual(['4100BE3EA813', '4100981A0001']);
    });

    it('drops the echo and SEARCHING..., and leaves single frames as printed', () => {
        // A single frame has no length field here: whether a trailing AA is CAN
        // padding or data is for the caller, who knows the expected length.
        expect(ecuPayloads('0100', '0100\rSEARCHING...\r4100BE3EA813AA\r4100981A0001AA\r\r')).toEqual([
            '4100BE3EA813AA',
            '4100981A0001AA',
        ]);
        expect(ecuPayloads('03', '43030101AA02AA\r\r')).toEqual(['43030101AA02AA']);
        expect(ecuPayloads('0100 1', '0100 1\r4100BE3EA813\r\r')).toEqual(['4100BE3EA813']);
    });

    it('reassembles ISO-TP segments and cuts them to the announced length', () => {
        const response =
            '013\r0:490401303545\r1:30313945423431\r2:38304245414AAA\r013\r0:490401304357\r1:39303635353645\r2:432B30353632\r\r';
        expect(ecuPayloads('0904', response)).toEqual([
            '4904013035453031394542343138304245414A',
            '49040130435739303635353645432B30353632',
        ]);
    });

    it('mixes multi-frame and single-frame responders', () => {
        expect(ecuPayloads('010C5E0D', '009\r0:410C153E5E00\r1:320D00AAAAAAAA\r410C14CC0D00\r\r')).toEqual([
            '410C153E5E00320D00',
            '410C14CC0D00',
        ]);
    });

    it('keeps negative responses and yields nothing for adapter errors', () => {
        expect(ecuPayloads('03', '4300\r7F0310\r4300\r\r')).toEqual(['4300', '7F0310', '4300']);
        expect(ecuPayloads('0A', 'NO DATA\r\r')).toEqual([]);
        expect(ecuPayloads('0100', 'UNABLE TO CONNECT\r')).toEqual([]);
        expect(ecuPayloads('0100', 'CAN ERROR\r')).toEqual([]);
    });

    it('rejects segments that arrive out of sequence (two ECUs interleaved by a clone)', () => {
        const interleaved =
            '013\r0:490401303545\r013\r0:490401304357\r1:30313945423431\r1:39303635353645\r2:38304245414AAA\r2:432B30353632\r\r';
        expect(ecuPayloads('0904', interleaved)).toEqual([]);
        expect(ecuPayloads('0904', '013\r0:490401303545\r1:30313945423431\r1:39303635353645\r\r')).toEqual([]);
        expect(ecuPayloads('0904', '013\r1:490401303545\r2:30313945423431\r3:38304245414AAA\r\r')).toEqual([]);
    });

    it('follows the sequence number past F back to 0', () => {
        const segments = Array.from(
            {length: 17},
            (_, index) => `${(index % 16).toString(16).toUpperCase()}:${index === 0 ? '490201AABBCC' : '11223344556677'}`,
        );
        const [payload] = ecuPayloads('0902', `076\r${segments.join('\r')}\r\r`);
        expect(payload?.length).toBe(0x76 * 2);
    });

    it('rejects a truncated multi-frame response', () => {
        expect(ecuPayloads('0601', '025\r0:46018B850037\r1:F5BF7FFF018A85\r\r')).toEqual([]);
    });
});

const x = (c: string, r: string, t = 0): Exchange => ({t, c, r});

describe('buildIdentity', () => {
    const exchanges: Exchange[] = [
        x('ATDPN', 'A7\r\r'),
        x('0100', '4100BE3EA813\r4100981A0001\r\r'),
        // The same answers from an adapter that pads every CAN frame.
        x('0100', '4100BE3EA813AA\r4100981A0001AA\r\r'),
        x('0100', '4100BE3EA813AA\r4100981A0001AA\r\r'),
        x('0101', '41010007F100AA\r410100040000AA\r\r'),
        x('03', '4300AAAAAAAAAA\r7F0310AAAAAAAA\r4300AAAAAAAAAA\r\r'),
        x('0120 1', '41208007B011\r\r'),
        x('0140 1', '4140FED0AC15\r\r'),
        x('0160 1', '41606B09A141\r\r'),
        x('0180 1', '41800024000D\r\r'),
        x('01A0 1', '41A014000000\r\r'),
        // A hint-ignoring adapter reveals the second ECU's further masks.
        x('0120 1', '41208007B011\r412000002001\r\r'),
        x('0140 1', '4140FED0AC15\r4140C4000000\r\r'),
        x('0101', '41010007F100\r410100040000\r\r'),
        x('0141', '41410007B1B1\r414100040000\r\r'),
        x('0902', '014\r0:490201544D42\r1:414E384E5A3253\r2:43393939393939\r\r'),
        x(
            '0904',
            '013\r0:490401303545\r1:30313945423431\r2:38304245414AAA\r013\r0:490401304357\r1:39303635353645\r2:432B30353632\r\r',
        ),
        x('0906', '490601AD343D35\r490601A9C9EF55\r\r'),
        x(
            '090A',
            '017\r0:490A0145434D\r1:002D456E67696E\r2:65436F6E74726F\r3:6C0000AAAAAAAA\r017\r0:490A0154434D\r1:002D5472616E73\r2:6D69734374726C\r3:000000\r\r',
        ),
        x('0908', '00B\r0:490804033B0C\r1:94038D033BAAAA\r\r', 1),
        x('0908', '00B\r0:490804033F0C\r1:A10391033FAAAA\r\r', 2),
        x('0600', '4600C0000001\r\r'),
        // A clone truncates the response: not a whole number of records.
        x('0602', '01B\r0:460205100032\r1:0000025802960A\r2:06680000066802\r3:950A180617FC28\r4:00\r\r', 1),
        x('0602', '01C\r0:46020510003C\r1:0000025802960A\r2:06360000066802\r3:950A17FC17FC28\r4:00AAAAAAAAAAAA\r\r', 2),
        x('03', '4300\r7F0310\r4300\r\r'),
        x('0A', 'NO DATA\r\r'),
        x('04', '7F0422\r7F0422\r7F0422\r\r'),
    ];
    const {profile, report, secrets} = buildIdentity(exchanges, {name: 'gasoline', vinSerial: '123456'});

    it('decodes the engine ECU PID set from its support masks, without the mask PIDs', () => {
        expect(profile.pids).toContain(0x0c);
        expect(profile.pids).toContain(0xa6);
        expect(profile.pids).not.toContain(0x20);
        expect(profile.pids).not.toContain(0x01);
        expect(profile.pids).not.toContain(0x02); // not in BE3EA813
    });

    it('drops PIDs the simulator cannot encode and reports them', () => {
        expect(report.unsupportedPids.length).toBeGreaterThan(0);
        for (const pid of report.unsupportedPids) expect(profile.pids).not.toContain(pid);
    });

    it('reads protocol, ignition, readiness and the mode 09 identity', () => {
        expect(profile.protocol).toBe('7');
        expect(profile.ignition).toBe('spark');
        expect(profile.readinessSinceClear).toEqual([0x07, 0xf1, 0x00]);
        expect(profile.readinessThisDriveCycle).toEqual([0x07, 0xb1, 0xb1]);
        expect(profile.calibrationId).toBe('05E019EB4180BEAJ');
        expect(profile.cvn).toBe('AD343D35');
        expect(profile.ecuName).toBe('ECM-EngineControl');
        expect(profile.performanceCounters).toEqual([0x033f, 0x0ca1, 0x0391, 0x033f]); // latest
    });

    it('never carries the recorded VIN', () => {
        expect(secrets).toContain('TMBAN8NZ2SC999999');
        expect(profile.vin).toBe('TMBAN8NZ2SC123456');
        expect(profile.vin).not.toContain('999999');
    });

    it('takes the latest complete mode 06 response', () => {
        expect(profile.monitorTests).toEqual([
            {mid: 0x02, tid: 0x05, uasId: 0x10, value: 0x003c, min: 0x0000, max: 0x0258},
            {mid: 0x02, tid: 0x96, uasId: 0x0a, value: 0x0636, min: 0x0000, max: 0x0668},
            {mid: 0x02, tid: 0x95, uasId: 0x0a, value: 0x17fc, min: 0x17fc, max: 0x2800},
        ]);
    });

    it('describes the other ECUs', () => {
        expect(profile.supportsPermanentDtcs).toBe(false);
        expect(profile.additionalEcus).toEqual([
            {id: '7EA', pids: [], dtcReply: 'reject'},
            {
                id: '7E9',
                name: 'TCM-TransmisCtrl',
                pids: [0x04, 0x05, 0x0c, 0x0d, 0x0f, 0x33, 0x42, 0x46],
                readiness: [0x04, 0x00, 0x00],
                calibrationId: '0CW906556EC+0562',
                cvn: 'A9C9EF55',
            },
        ]);
    });

    it('notices a vehicle that refuses to clear codes while running', () => {
        expect(report.refusesClearWhileRunning).toBe(true);
        expect(report.missing).toEqual([]);
    });

    it('fails without the support masks', () => {
        expect(() => buildIdentity([x('ATDPN', 'A7\r\r')], {name: 'x', vinSerial: '123456'})).toThrow('0100');
    });
});

describe('anonymize', () => {
    it('keeps manufacturer, model and year, replaces the serial', () => {
        expect(syntheticVin('TMBAN8NZ2SC999999', '123456')).toBe('TMBAN8NZ2SC123456');
        expect(() => syntheticVin('SHORT', '123456')).toThrow('17');
        expect(() => syntheticVin('TMBAN8NZ2SC999999', '999999')).toThrow('serial');
    });

    it('refuses output that contains a recorded secret', () => {
        expect(() => assertNoLeak("vin: 'TMBAN8NZ2SC999999'", ['TMBAN8NZ2SC999999'])).toThrow('leak');
        expect(() => assertNoLeak('id c8ee5306-668e', ['C8EE5306-668E'])).toThrow('leak');
        expect(() => assertNoLeak("vin: 'TMBAN8NZ2SC123456'", ['TMBAN8NZ2SC999999', ''])).not.toThrow();
    });
});

describe('drive cycle extraction', () => {
    // 1 Hz drive: 10 s standstill, ramp to 100 km/h over 20 s, hold 20 s, ramp down 20 s, 10 s standstill.
    const speedAt = (s: number) => (s < 10 ? 0 : s < 30 ? (s - 10) * 5 : s < 50 ? 100 : s < 70 ? (70 - s) * 5 : 0);
    const samples: Sample[] = Array.from({length: 80}, (_, s) => [
        {t: s * 1000, p: 'speed', v: speedAt(s)},
        {t: s * 1000 + 100, p: 'rpm', v: 900 + speedAt(s) * 20},
        {t: s * 1000 + 200, p: 'throttle', v: 12 + speedAt(s) / 4},
        {t: s * 1000 + 300, p: 'engineLoad', v: 20 + speedAt(s) / 2},
        {t: s * 1000 + 400, p: 'fuelRate', v: 0.8 + speedAt(s) / 10},
    ]).flat();

    it('resamples to 1 Hz and fills short gaps', () => {
        const gappy = samples.filter((sample) => sample.p !== 'rpm' || Math.floor(sample.t / 1000) % 3 === 0);
        const series = toSeries(gappy);
        expect(series.rpm.length).toBe(80);
        expect(series.rpm[1]).toBe(series.rpm[0]);
        expect(series.speedKmh[20]).toBe(50);
    });

    it('picks a window that starts and ends at standstill', () => {
        const cycle = buildCycle([toSeries(samples)], {seconds: 70, minTopSpeedKmh: 90});
        expect(cycle.stepSeconds).toBe(1);
        expect(cycle.speedKmh.length).toBe(70);
        expect(cycle.speedKmh[0]).toBe(0);
        expect(cycle.speedKmh[69]).toBe(0);
        expect(Math.max(...cycle.speedKmh)).toBe(100);
        expect(cycle.rpm.length).toBe(70);
        expect(cycle.fuelRateLph?.length).toBe(70);
    });

    it('fails when no drive qualifies', () => {
        expect(() => buildCycle([toSeries(samples)], {seconds: 70, minTopSpeedKmh: 150})).toThrow('no window');
    });
});

describe('deriveTraits', () => {
    it('takes medians of what the vehicle reported', () => {
        const samples: Sample[] = [
            ...[900, 930, 960].map((v, i) => [
                {t: i * 1000, p: 'speed', v: 0},
                {t: i * 1000, p: 'rpm', v},
            ]),
            {t: 5000, p: 'speed', v: 50},
            {t: 5000, p: 'rpm', v: 2500},
            ...[60, 92, 93, 94, 93].map((v, i) => ({t: i * 1000, p: 'coolant', v})),
            ...[13.8, 13.9, 14.0].map((v, i) => ({t: i * 1000, p: 'moduleVoltage', v})),
            ...[-5.47, -5.47, -4.69].map((v, i) => ({t: i * 1000, p: 'ltft1', v})),
            ...[40, 42, 44].map((v, i) => ({t: i * 1000, p: 'intakeTemp', v})),
        ].flat();
        expect(deriveTraits(samples)).toEqual({
            idleRpm: 930,
            coolantTargetC: 93,
            chargingVoltage: 13.9,
            longTermFuelTrimPct: -5.5,
            intakeTempC: 42,
        });
    });

    it('leaves out what was never recorded', () => {
        expect(deriveTraits([])).toEqual({});
    });
});
