import {describe, expect, it} from 'vitest';
import {assertNoLeak, syntheticVin} from '../../tools/import-vehicle/anonymize';
import {buildCycle, toSeries} from '../../tools/import-vehicle/cycle';
import {decodeMode01, withDecodedSamples} from '../../tools/import-vehicle/decode';
import {buildIdentity, sourceAddresses} from '../../tools/import-vehicle/identity';
import {ecuPayloads, framePaddingOf} from '../../tools/import-vehicle/responses';
import {fitSignals} from '../../tools/import-vehicle/signals';
import {ambientTrait, deriveTraits, deriveWarmup} from '../../tools/import-vehicle/traits';
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

    it('finds the byte the vehicle pads its last frame with', () => {
        expect(framePaddingOf('0902', '014\r0:490201544D42\r1:414E384E5A3253\r2:43393939393939\r\r')).toBeNull(); // exact fit
        expect(framePaddingOf('010C5E0D', '009\r0:410C153E5E00\r1:320D00AAAAAAAA\r\r')).toBe('AA');
        expect(framePaddingOf('010C5E0D', '009\r0:410C153E5E00\r1:320D00\r\r')).toBeNull();
        expect(framePaddingOf('010C5E0D', '009\r0:410C153E5E00\r1:320D0055AA55AA\r\r')).toBeNull(); // not one byte repeated
        expect(framePaddingOf('0100', '4100BE3EA813\r\r')).toBeNull();
        // Two responders: segments are ambiguous, no verdict.
        expect(
            framePaddingOf('0904', '013\r0:490401303545\r1:30313945423431\r2:38304245414AAA\r013\r0:490401304357\r\r'),
        ).toBeNull();
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
        x('010C5E0D 1', '009\r0:410C153E5E00\r1:320D00AAAAAAAA\r\r'),
        x('04', '7F0422\r7F0422\r7F0422\r7F0422\r\r'),
        x('04', '44\r7F0478\r7F0478\r44\r\r'),
        // The adapter probe: headers on for one request.
        x('ATH1', 'OK\r\r'),
        x('010C 1', '18DAF10104410C0E86AAAAAA\r18DAF10204410C0E88AAAAAA\r\r'),
        x('ATH0', 'OK\r\r'),
        x('01A4 1', '41A401000000\r\r'),
        x('01A4 1', '41A401200000\r\r'),
    ];
    const {profile, report, secrets} = buildIdentity(exchanges, {name: 'gasoline', vinSerial: '123456'});

    it('decodes the engine ECU PID set from its support masks, without the mask PIDs', () => {
        expect(profile.pids).toContain(0x0c);
        expect(profile.pids).toContain(0xa6);
        expect(profile.pids).not.toContain(0x20);
        expect(profile.pids).not.toContain(0x01);
        expect(profile.pids).not.toContain(0x02); // not in BE3EA813
    });

    it('serves every PID this car advertises', () => {
        expect(report.unsupportedPids).toEqual([]);
        for (const pid of [0x65, 0x6d, 0x9d, 0x9e]) expect(profile.pids).toContain(pid);
    });

    it('drops PIDs the simulator cannot encode and reports them', () => {
        // The same car advertising PID 86 (NOx sensor), which has no encoder.
        const nox = exchanges.map((exchange) => (exchange.c === '0180 1' ? x('0180 1', '41800424000D\r\r') : exchange));
        const built = buildIdentity(nox, {name: 'gasoline', vinSerial: '123456'});
        expect(built.report.unsupportedPids).toEqual([0x86]);
        expect(built.profile.pids).not.toContain(0x86);
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
            {id: '7EA', pids: [], dtcReply: 'reject', clearReply: 'pending'},
            {
                id: '7E9',
                sourceAddress: 0x02,
                name: 'TCM-TransmisCtrl',
                pids: [0x04, 0x05, 0x0c, 0x0d, 0x0f, 0x33, 0x42, 0x46],
                readiness: [0x04, 0x00, 0x00],
                calibrationId: '0CW906556EC+0562',
                cvn: 'A9C9EF55',
            },
            // Answers mode 04 and nothing else.
            {id: '7EB', pids: [], dtcReply: 'none', clearReply: 'pending'},
        ]);
    });

    it('records the frame padding byte', () => {
        expect(profile.framePadding).toBe(0xaa);
    });

    it('reads the 29-bit source addresses off a headers-on exchange', () => {
        expect(profile.sourceAddress).toBe(0x01);
        expect(profile.additionalEcus?.find((ecu) => ecu.id === '7E9')?.sourceAddress).toBe(0x02);
        expect(sourceAddresses([x('ATH1', 'OK'), x('017A', '18 DA F1 01 10 09 41 7A\r18 DA F1 01 21 00\r\r')])).toEqual([0x01]);
        expect(sourceAddresses([x('ATH1', 'OK'), x('ATZ', 'ELM327'), x('010C', '18DAF10104410C0E86\r\r')])).toEqual([]);
        expect(sourceAddresses([x('010C', '410C0E86\r\r')])).toEqual([]);
    });

    it('notices a PID A4 that carries the gear alone', () => {
        expect(profile.transmissionPid).toBe('gear');
        const ratio = exchanges.map((exchange) => (exchange.c === '01A4 1' ? {...exchange, r: '41A40310036B\r\r'} : exchange));
        expect(buildIdentity(ratio, {name: 'gasoline', vinSerial: '123456'}).profile.transmissionPid).toBeUndefined();
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

describe('fitSignals', () => {
    // A drive where MAP = 25 + 0.8·load + 2·krpm exactly, timing advance is unrelated noise,
    // barometric pressure is constant and one glitch hits the MAP sensor.
    const drive = (offsetMs: number): Sample[] =>
        Array.from({length: 400}, (_, i) => {
            const t = offsetMs + i * 1000;
            const load = 10 + ((i * 7) % 80);
            const rpm = 900 + ((i * 131) % 3000);
            const speed = (i * 3) % 120;
            return [
                {t, p: 'engineLoad', v: load},
                {t: t + 10, p: 'rpm', v: rpm},
                {t: t + 20, p: 'speed', v: speed},
                {t: t + 30, p: 'intakeMap', v: i === 200 ? 6000 : 25 + 0.8 * load + (2 * rpm) / 1000},
                {t: t + 40, p: 'timingAdvance', v: 10 + ((i * 37) % 11) - 5},
                {t: t + 50, p: 'baro', v: 100},
                {t: t + 60, p: 'someUnknownChannel', v: 1},
            ];
        }).flat();
    const {signals: fits, diagnosis} = fitSignals([drive(0), drive(10_000_000)], [0x0b, 0x0e, 0x33]);

    it('recovers how a signal follows the driving state', () => {
        const map = fits[0x0b];
        expect(map?.base).toBeCloseTo(25, 1);
        expect(map?.perLoadPct).toBeCloseTo(0.8, 2);
        expect(map?.perKrpm).toBeCloseTo(2, 1);
        expect(map?.perKmh).toBeCloseTo(0, 2);
        expect(map?.noise).toBeLessThan(0.5);
    });

    it('cuts glitches out of the range', () => {
        expect(fits[0x0b]?.max).toBeLessThan(200);
    });

    it('reports what it decided per channel', () => {
        expect(diagnosis.map(({pid, outcome}) => [pid, outcome])).toEqual([
            [0x0b, 'sloped'],
            [0x0e, 'none'],
            [0x33, 'constant'],
        ]);
        expect(diagnosis[0]?.rSquared).toBeGreaterThan(0.99);
        expect(diagnosis[1]?.rSquared).toBeLessThan(0.5);
    });

    it('calls a channel that barely moves a constant', () => {
        expect(fits[0x33]).toEqual({base: 100, perLoadPct: 0, perKrpm: 0, perKmh: 0, min: 100, max: 100, noise: 0});
    });

    it('leaves a lively channel the state does not explain to the generic formula', () => {
        // Timing advance swings ±5° around 10° unrelated to the state: freezing it would be worse.
        expect(fits[0x0e]).toBeUndefined();
    });

    it('bounds the noise by the measured range, not by the residual', () => {
        const noisy = drive(0).map((sample, i) =>
            sample.p === 'intakeMap' ? {...sample, v: sample.v + ((i * 7919) % 41) - 20} : sample,
        );
        const fit = fitSignals([noisy], [0x0b]).signals[0x0b];
        expect(fit?.perLoadPct).toBeCloseTo(0.8, 0);
        expect(fit?.noise).toBeLessThanOrEqual(0.02 * ((fit?.max ?? 0) - (fit?.min ?? 0)) + 1e-9);
    });

    it('does not freeze a signal that is usually at rest but has a wide range', () => {
        // A pedal read mostly at idle: 95 % of the samples at 14 %, the rest up to 60 %.
        const pedal = drive(0).map((sample, i) =>
            sample.p === 'baro' ? {...sample, p: 'pedalPosition', v: Math.floor(i / 7) % 20 === 0 ? 60 : 14} : sample,
        );
        expect(fitSignals([pedal], [0x49]).signals).toEqual({});
    });

    it('needs a minimum of samples even for a constant', () => {
        expect(fitSignals([drive(0).slice(0, 7 * 10)], [0x33]).signals).toEqual({}); // 10 samples are not
    });

    it('judges "barely moves" against the full scale, so small values can be constants', () => {
        // Friction torque 4..6 % on a 255 % scale: tiny in absolute terms, large relative to its median.
        const friction = drive(0).map((sample, i) =>
            sample.p === 'baro' ? {...sample, p: 'frictionTorque', v: 4 + (i % 3)} : sample,
        );
        expect(fitSignals([friction], [0x8e]).signals[0x8e]).toMatchObject({base: 5, perLoadPct: 0, min: 4, max: 6});
    });

    it('never fits lambda or counters', () => {
        const lambda = drive(0).map((sample) => (sample.p === 'baro' ? {...sample, p: 'commandedLambda', v: 1} : sample));
        expect(fitSignals([lambda], [0x44]).signals).toEqual({});
    });

    it('fits only requested PIDs and known channels, and needs a fresh driving state', () => {
        expect(Object.keys(fitSignals([drive(0)], [0x33]).signals)).toEqual([String(0x33)]);
        const stale: Sample[] = [
            {t: 0, p: 'engineLoad', v: 20},
            {t: 0, p: 'rpm', v: 900},
            {t: 0, p: 'speed', v: 0},
            {t: 60_000, p: 'baro', v: 100},
        ];
        expect(fitSignals([stale], [0x33]).signals).toEqual({});
    });

    it('fits against rpm and speed alone when load was hardly ever logged with the channel', () => {
        // EGT = 300 + 80·krpm + 1.5·kmh, with load logged only in the first two samples.
        const egt = Array.from({length: 400}, (_, i) => {
            const t = i * 1000;
            const rpm = 900 + ((i * 131) % 3000);
            const speed = (i * 3) % 120;
            return [
                ...(i < 2 ? [{t, p: 'engineLoad', v: 20}] : []),
                {t: t + 10, p: 'rpm', v: rpm},
                {t: t + 20, p: 'speed', v: speed},
                {t: t + 30, p: 'egtB1S1', v: 300 + (80 * rpm) / 1000 + 1.5 * speed},
            ];
        }).flat();
        const fit = fitSignals([egt], [0x78]).signals[0x78];
        expect(fit?.base).toBeCloseTo(300, 0);
        expect(fit?.perLoadPct).toBe(0);
        expect(fit?.perKrpm).toBeCloseTo(80, 0);
        expect(fit?.perKmh).toBeCloseTo(1.5, 2);
    });

    it('does not fit slopes to a handful of samples', () => {
        const few = drive(0).slice(0, 7 * 20);
        expect(fitSignals([few], [0x0b]).signals[0x0b]).toBeUndefined(); // lively and unexplained → generic formula
        expect(fitSignals([few], [0x33]).signals[0x33]?.base).toBe(100); // 20 samples are enough for a constant
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

    it('derives the warm-up from cold starts only', () => {
        // Coolant every 10 s: start + (93 − start)·(1 − e^(−t/200)).
        const session = (start: number, offsetMs: number): Sample[] =>
            Array.from({length: 120}, (_, i) => ({
                t: offsetMs + i * 10_000,
                p: 'coolant',
                v: Math.round(start + (93 - start) * (1 - Math.exp(-(i * 10) / 200))),
            }));
        const oil = (offsetMs: number): Sample[] =>
            [90, 95, 96].map((v, i) => ({t: offsetMs + 1_100_000 + i * 1000, p: 'oilTemp', v}));
        const cold = [40, 44, 48].map((start, i) => [...session(start, i * 10_000_000), ...oil(i * 10_000_000)]);
        const warm = [...session(88, 50_000_000)];
        const traits = deriveWarmup([...cold, warm], 93);
        expect(traits.coolantStartC).toBe(44); // median of the cold starts; the warm start does not count
        expect(traits.coolantWarmupTauS).toBeGreaterThan(170);
        expect(traits.coolantWarmupTauS).toBeLessThan(230);
        expect(traits.oilOverCoolantC).toBe(2); // warm oil median 95 − target 93
    });

    it('says nothing about the warm-up without enough cold starts', () => {
        const one: Sample[] = Array.from({length: 60}, (_, i) => ({t: i * 10_000, p: 'coolant', v: Math.min(93, 40 + i)}));
        expect(deriveWarmup([one], 93)).toEqual({});
        expect(deriveWarmup([], 93)).toEqual({});
    });

    it('leaves out what was never recorded', () => {
        expect(deriveTraits([])).toEqual({});
    });

    it('takes the latest reading of the in-use counters, the fuel level and the odometer — they drift, a median would lag', () => {
        const samples: Sample[] = [
            {t: 1000, p: 'odometer', v: 51_050.3},
            {t: 9000, p: 'odometer', v: 51_160.4},
            {t: 5000, p: 'odometer', v: 51_100},
            {t: 1000, p: 'fuelLevel', v: 85.9},
            {t: 9000, p: 'fuelLevel', v: 97.25},
            {t: 1000, p: 'warmupsSinceClear', v: 80},
            {t: 9000, p: 'warmupsSinceClear', v: 83},
            {t: 1000, p: 'distanceSinceClear', v: 2765},
            {t: 9000, p: 'distanceSinceClear', v: 2874},
        ];
        expect(deriveTraits(samples)).toEqual({
            odometerKm: 51_160.4,
            fuelLevelPct: 97,
            warmupsSinceClear: 83,
            distanceSinceClearKm: 2874,
        });
    });
});

describe('ambientTrait', () => {
    it('reads the recorded day off the ambient fit at the reference cruise state', () => {
        const fit = {0x46: {base: 35.21, perLoadPct: 0, perKrpm: -0.5154, perKmh: -0.06282, min: 24, max: 45, noise: 0.42}};
        expect(ambientTrait(fit, [])).toEqual({ambientC: 30.4}); // 35.21 − 1.03 − 3.77
    });

    it('falls back to the median of the logged ambient temperature, and says nothing without either', () => {
        const samples: Sample[] = [27, 28, 40].map((v, i) => ({t: i * 1000, p: 'ambientTemp', v}));
        expect(ambientTrait({}, samples)).toEqual({ambientC: 28});
        expect(ambientTrait({}, [])).toEqual({});
    });
});

describe('decodeMode01', () => {
    const at = (c: string, r: string) => decodeMode01({t: 1, c, r});

    it("decodes single and batch answers of the engine ECU with the encoders' byte counts", () => {
        expect(at('0178 1', '00B\r0:417803179A00\r1:0000000000AAAA\r\r')).toEqual([{t: 1, p: 'egtB1S1', v: 564.2}]);
        expect(at('013C 1', '413C1A2BAAAAAA\r\r')).toEqual([{t: 1, p: 'catalystTemp', v: 629.9}]);
        expect(at('010C0D055E 1', '00B\r0:410C0EE40D00\r1:05565E0017AAAA\r\r')).toEqual([
            {t: 1, p: 'rpm', v: 953},
            {t: 1, p: 'speed', v: 0},
        ]);
        expect(at('0104115C 1', '41043811205C89\r\r')).toEqual([{t: 1, p: 'engineLoad', v: (0x38 * 100) / 255}]);
        expect(at('01430E 1', '4143002A0E96\r\r')).toEqual([
            {t: 1, p: 'absoluteLoad', v: (0x2a * 100) / 255},
            {t: 1, p: 'timingAdvance', v: 11},
        ]);
    });

    it('ignores other services, errors, the second ECU and payloads it cannot walk', () => {
        expect(at('0902', '014\r0:490201544D42\r1:414E384E5A3253\r2:43393939393939\r\r')).toEqual([]);
        expect(at('0178 1', 'NO DATA\r\r')).toEqual([]);
        expect(at('010F', '410F5A\r410F53\r\r')).toEqual([{t: 1, p: 'intakeTemp', v: 50}]);
        expect(at('01FF 1', '41FF01\r\r')).toEqual([]);
    });

    it("replaces the app's decoding of a fitted channel, keeps the rest", () => {
        const samples = [
            {t: 0, p: 'rpm', v: 900},
            {t: 0, p: 'egtB1S1', v: 300},
            {t: 0, p: 'coolant', v: 90},
        ];
        const merged = withDecodedSamples(samples, [{t: 1, c: '0178 1', r: '00B\r0:417803179A00\r1:0000000000AAAA\r\r'}]);
        expect(merged).toEqual([
            {t: 0, p: 'rpm', v: 900},
            {t: 0, p: 'coolant', v: 90},
            {t: 1, p: 'egtB1S1', v: 564.2},
        ]);
    });
});
