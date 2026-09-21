import {PID_ENCODERS} from '../../src/core/j1979';
import type {CanProtocol, EcuProfile, MonitorTestRecord, ReadinessBytes, VehicleProfile} from '../../src/core/types';
import {syntheticVin} from './anonymize';
import {ecuPayloads, framePaddingOf, requestOf} from './responses';
import type {Exchange} from './session';

// Builds the VehicleProfile from everything the vehicle ever answered:
// support masks, status PIDs, mode 06, mode 09, DTC services. Static answers
// are taken by majority across sessions (clones truncate and interleave);
// values that drift (counters, monitor results) from the latest recording.
// The first responder is the engine ECU, the second becomes 7E9.

export interface IdentityOptions {
    /**
     * VehicleProfile.name.
     */
    name: string;
    /**
     * Six digits replacing the recorded VIN serial.
     */
    vinSerial: string;
}

export interface IdentityReport {
    /**
     * Advertised by the vehicle, but the simulator has no encoder for them.
     */
    unsupportedPids: readonly number[];
    /**
     * Requests that would have been useful and were never sent.
     */
    missing: readonly string[];
    /**
     * The vehicle answered 04 with 7F 04 22 — a candidate for
     * `clearRequiresEngineOff`, which is left to the maintainer to enable.
     */
    refusesClearWhileRunning: boolean;
}

export interface IdentityResult {
    profile: VehicleProfile;
    report: IdentityReport;
    /**
     * Recorded identifiers that must not appear in any output.
     */
    secrets: readonly string[];
}

interface Answer {
    t: number;
    payloads: readonly string[];
}

const MASK_BLOCK = 0x20;
const LAST_MASK_BASE = 0xa0;
const STATUS_PIDS: readonly number[] = [0x01, 0x41];
const RECORD_BYTES = 9;
const MASK_BYTES = 4;
const CVN_BYTES = 4;
const CAN_PROTOCOLS: readonly string[] = ['6', '7', '8', '9'];
const COMPRESSION_IGNITION_BIT = 0x08;
const SECOND_ECU_ID = '7E9';
const REJECTING_ECU_ID = '7EA';

const hex2 = (value: number): string => value.toString(16).toUpperCase().padStart(2, '0');
const bytesOf = (payload: string): number[] => payload.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? [];
const ascii = (payload: string, skipBytes: number): string =>
    bytesOf(payload)
        .slice(skipBytes)
        .filter((byte) => byte !== 0)
        .map((byte) => String.fromCharCode(byte))
        .join('');

function mostCommon(values: readonly string[]): string | null {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// PIDs a 4-byte support mask advertises, the next block's mask PID included.
function pidsOfMask(base: number, maskHex: string): number[] {
    const bits = bytesOf(maskHex);
    return Array.from({length: MASK_BLOCK}, (_, offset) => offset).flatMap((offset) => {
        const set = ((bits[offset >> 3] ?? 0) & (0x80 >> (offset & 7))) !== 0;
        return set ? [base + offset + 1] : [];
    });
}

class Answers {
    private readonly byRequest = new Map<string, Answer[]>();

    constructor(exchanges: readonly Exchange[]) {
        for (const exchange of exchanges) {
            const request = requestOf(exchange.c);
            const payloads = ecuPayloads(exchange.c, exchange.r);
            if (payloads.length === 0) continue;
            this.byRequest.set(request, [...(this.byRequest.get(request) ?? []), {t: exchange.t, payloads}]);
        }
    }

    has(request: string): boolean {
        return this.byRequest.has(request);
    }

    /**
     * Majority payload of the n-th responder that starts with `prefix`.
     * `dataBytes` is the known length after the prefix: single frames are
     * cut to it, which is what removes an adapter's AA padding; responses
     * that are shorter do not count.
     */
    majority(request: string, responder: number, prefix: string, dataBytes?: number): string | null {
        const wanted = dataBytes === undefined ? null : prefix.length + dataBytes * 2;
        const candidates = (this.byRequest.get(request) ?? [])
            .map((answer) => answer.payloads[responder] ?? '')
            .filter((payload) => payload.startsWith(prefix) && (wanted === null || payload.length >= wanted))
            .map((payload) => (wanted === null ? payload : payload.slice(0, wanted)));
        return mostCommon(candidates);
    }

    /**
     * Latest payload of the first responder accepted by `wellFormed`.
     */
    latest(request: string, wellFormed: (payload: string) => boolean): string | null {
        const candidates = (this.byRequest.get(request) ?? [])
            .filter((answer) => wellFormed(answer.payloads[0] ?? ''))
            .sort((a, b) => b.t - a.t);
        return candidates[0]?.payloads[0] ?? null;
    }

    /**
     * Any responder ever answered `payload` (padded or not) to the request.
     */
    sawPayload(request: string, payload: string): boolean {
        return (this.byRequest.get(request) ?? []).some((answer) =>
            answer.payloads.some((printed) => printed.startsWith(payload) && /^(AA)*$/.test(printed.slice(payload.length))),
        );
    }

    requests(): string[] {
        return [...this.byRequest.keys()];
    }
}

// Follows the mask chain 00 → 20 → ... of one responder.
function advertisedPids(answers: Answers, responder: number): number[] {
    const pids: number[] = [];
    for (let base = 0; base <= LAST_MASK_BASE; base += MASK_BLOCK) {
        const prefix = `41${hex2(base)}`;
        const payload = answers.majority(`01${hex2(base)}`, responder, prefix, MASK_BYTES);
        if (!payload) break;
        const block = pidsOfMask(base, payload.slice(prefix.length));
        pids.push(...block);
        if (!block.includes(base + MASK_BLOCK)) break;
    }
    return pids.filter((pid) => pid % MASK_BLOCK !== 0 && !STATUS_PIDS.includes(pid));
}

function readiness(answers: Answers, pid: number, responder: number): ReadinessBytes | null {
    const prefix = `41${hex2(pid)}`;
    const payload = answers.majority(`01${hex2(pid)}`, responder, prefix, MASK_BYTES);
    if (!payload) return null;
    const [, b = 0, c = 0, d = 0] = bytesOf(payload.slice(prefix.length));
    return [b, c, d];
}

function monitorTests(answers: Answers): MonitorTestRecord[] {
    const complete = (payload: string) => payload.startsWith('46') && (payload.length / 2 - 1) % RECORD_BYTES === 0;
    return answers
        .requests()
        .filter((request) => /^06[0-9A-F]{2}$/.test(request) && Number.parseInt(request.slice(2), 16) % MASK_BLOCK !== 0)
        .sort()
        .flatMap((request) => {
            const bytes = bytesOf(answers.latest(request, complete) ?? '').slice(1);
            return Array.from({length: bytes.length / RECORD_BYTES}, (_, record) => {
                const [mid = 0, tid = 0, uasId = 0, v1 = 0, v0 = 0, n1 = 0, n0 = 0, x1 = 0, x0 = 0] = bytes.slice(
                    record * RECORD_BYTES,
                    (record + 1) * RECORD_BYTES,
                );
                return {mid, tid, uasId, value: v1 * 256 + v0, min: n1 * 256 + n0, max: x1 * 256 + x0};
            });
        });
}

function performanceCounters(answers: Answers, infotype: string): number[] {
    const prefix = `49${infotype}`;
    const complete = (payload: string) => {
        const [, , count = -1] = bytesOf(payload);
        return payload.startsWith(prefix) && payload.length / 2 === 3 + count * 2;
    };
    const words = bytesOf(answers.latest(`09${infotype}`, complete) ?? '').slice(3);
    return Array.from({length: words.length / 2}, (_, index) => (words[index * 2] ?? 0) * 256 + (words[index * 2 + 1] ?? 0));
}

function secondEcu(answers: Answers, enginePids: readonly number[]): EcuProfile | null {
    const pids = advertisedPids(answers, 1).filter((pid) => enginePids.includes(pid));
    if (!answers.majority('0100', 1, '4100', MASK_BYTES)) return null;
    const name = ascii(answers.majority('090A', 1, '490A') ?? '', 3);
    const calibrationId = ascii(answers.majority('0904', 1, '4904') ?? '', 3);
    const cvn = (answers.majority('0906', 1, '490601', CVN_BYTES) ?? '').slice(6);
    const status = readiness(answers, 0x01, 1);
    return {
        id: SECOND_ECU_ID,
        ...(name ? {name} : {}),
        pids,
        ...(status ? {readiness: status} : {}),
        ...(calibrationId ? {calibrationId} : {}),
        ...(cvn ? {cvn} : {}),
    };
}

// ATDPN prints 'A7' (automatic, protocol 7) or '7'.
function protocolOf(exchanges: readonly Exchange[]): CanProtocol | null {
    const described = exchanges
        .filter((exchange) => requestOf(exchange.c) === 'ATDPN')
        .map((exchange) => exchange.r.replace(/\s/g, '').toUpperCase())
        .filter((value) => /^A?[0-9A-C]$/.test(value));
    const digit = mostCommon(described)?.slice(-1) ?? '';
    return CAN_PROTOCOLS.includes(digit) ? (digit as CanProtocol) : null;
}

/**
 * @throws if the recordings lack the essentials (support masks, VIN).
 */
export function buildIdentity(exchanges: readonly Exchange[], options: IdentityOptions): IdentityResult {
    const answers = new Answers(exchanges);
    const asked = new Set(exchanges.map((exchange) => requestOf(exchange.c)));
    if (!answers.has('0100')) throw new Error('no usable 0100 response recorded — cannot tell which PIDs the vehicle supports');

    const advertised = advertisedPids(answers, 0);
    const pids = advertised.filter((pid) => PID_ENCODERS[pid] !== undefined);
    const recordedVin = ascii(answers.majority('0902', 0, '4902') ?? '', 3);
    if (!recordedVin) throw new Error('no 0902 (VIN) response recorded');

    const sinceClear = readiness(answers, 0x01, 0);
    const thisCycle = readiness(answers, 0x41, 0);
    const compression = ((sinceClear?.[0] ?? 0) & COMPRESSION_IGNITION_BIT) !== 0;
    const counterInfotype = compression ? '0B' : '08';
    const second = secondEcu(answers, pids);
    const rejectsDtcRequests = answers.sawPayload('03', '7F0310');
    const additionalEcus: EcuProfile[] = [
        ...(rejectsDtcRequests ? [{id: REJECTING_ECU_ID, pids: [], dtcReply: 'reject' as const}] : []),
        ...(second ? [second] : []),
    ];
    const protocol = protocolOf(exchanges);
    const paddingHex = mostCommon(
        exchanges.map((exchange) => framePaddingOf(exchange.c, exchange.r)).filter((byte): byte is string => byte !== null),
    );
    const required = ['0101', '0141', '0904', '0906', '090A', `09${counterInfotype}`, '0600', '03', '0A'];

    return {
        profile: {
            name: options.name,
            vin: syntheticVin(recordedVin, options.vinSerial),
            calibrationId: ascii(answers.majority('0904', 0, '4904') ?? '', 3),
            cvn: (answers.majority('0906', 0, '490601', CVN_BYTES) ?? '').slice(6),
            ecuName: ascii(answers.majority('090A', 0, '490A') ?? '', 3),
            ignition: compression ? 'compression' : 'spark',
            pids,
            readinessSinceClear: sinceClear ?? [0, 0, 0],
            readinessThisDriveCycle: thisCycle ?? sinceClear ?? [0, 0, 0],
            performanceCounters: performanceCounters(answers, counterInfotype),
            monitorTests: monitorTests(answers),
            ...(protocol ? {protocol} : {}),
            ...(additionalEcus.length > 0 ? {additionalEcus} : {}),
            // Asked and never answered → the vehicle has no mode 0A.
            supportsPermanentDtcs: !asked.has('0A') || answers.has('0A'),
            ...(paddingHex ? {framePadding: Number.parseInt(paddingHex, 16)} : {}),
        },
        report: {
            unsupportedPids: advertised.filter((pid) => PID_ENCODERS[pid] === undefined),
            missing: required.filter((request) => !asked.has(request)),
            refusesClearWhileRunning: answers.sawPayload('04', '7F0422'),
        },
        secrets: [recordedVin],
    };
}
