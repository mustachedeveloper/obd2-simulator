import type {
    AdapterPersona,
    CanProtocol,
    CommandResult,
    DrivingModel,
    DtcStatus,
    EcuProfile,
    LinkState,
    ReadinessBytes,
    SimulatorLogger,
    VehicleProfile,
} from './types';
import {DefaultDrivingModel} from './DefaultDrivingModel';
import {mulberry32} from './prng';
import {PID_ENCODERS, encodeDtc, maskBytesFor, normalizeDtc, toHex} from './j1979';
import {GASOLINE_PROFILE} from '../profiles/gasoline';
import {DEFAULT_ADAPTER} from '../adapters/presets';
import {AUTO_PROTOCOL, handleAtCommand, handleStCommand, resetLinkState} from './at-commands';
import {formatLines, hexToBytes, type EcuResponse} from './framing';
import {ADDITIONAL_ECU_ID, ENGINE_ECU_ID, addressedEcus, isExtended} from './ecus';
import {mode09Responses, type VehicleInfoSource} from './mode09';
import {waitMsFor, type CommandKind} from './timing';

// Wire-level fake vehicle + ELM327 adapter in one object: feed it the exact
// ASCII commands a real adapter receives, get back the exact text a real
// adapter prints (echo, spaces, line endings, ISO-TP long-response framing,
// support masks, multi-ECU lines, negative responses, SEARCHING...) plus the
// latency the adapter would have taken. Transports (in-process link, TCP
// server) only move these strings and wait.
//
// Simulated surface: AT/ST command set, mode 01 (profile PID set + status
// PIDs 0x01/0x41, batch, multi-ECU), mode 02 freeze frame, modes 03/07/0A
// + 04 DTC lifecycle, mode 06 monitor tests, mode 09 vehicle info; every
// other hex request is rejected with 7F xx 11. The vehicle profile decides
// which ECUs answer; the adapter persona decides identity, quirks and timing.

export interface SimulatorEngineOptions {
    profile?: VehicleProfile;
    model?: DrivingModel;
    adapter?: AdapterPersona;
    // Injectable clock for deterministic tests; defaults to Date.now.
    now?: () => number;
    seed?: number;
    logger?: SimulatorLogger;
    // Replaces the persona's base + jitter latency (e.g. a distribution
    // derived from a recorded wire log). The ATST wait is still added.
    latencyFor?: (command: string) => number;
}

const MASK_BLOCK = 0x20;
const LAST_MASK_BASE = 0xa0;
const DEFAULT_PROTOCOL: CanProtocol = '6';
const HEX_REQUEST = /^([0-9A-F]{2})+$/;
const NEGATIVE_RESPONSE = 0x7f;
const NRC_GENERAL_REJECT = 0x10;
const NRC_SERVICE_NOT_SUPPORTED = 0x11;
const MIL_BIT = 0x80;
const MAX_DTC_COUNT = 0x7f;
const ZERO_READINESS: ReadinessBytes = [0, 0, 0];

// One ECU as the engine serves it. The engine ECU carries the DTC lists and
// the whole profile; the others answer their declared subset.
interface Ecu {
    id: string;
    isEngine: boolean;
    pids: ReadonlySet<number>;
    readinessSinceClear: ReadinessBytes;
    readinessThisDriveCycle: ReadinessBytes;
    dtcReply: 'list' | 'empty' | 'reject' | 'none';
    info: VehicleInfoSource;
}

interface Outcome {
    lines: string[];
    kind: CommandKind;
    hint: number | null;
    responders: number;
    // A protocol search ran for this command (SEARCHING... printed).
    searched: boolean;
    // Link settings after the command; respond() applies it.
    state: LinkState;
}

function validateEcuProfile(ecu: EcuProfile): EcuProfile {
    if (!ADDITIONAL_ECU_ID.test(ecu.id)) {
        throw new Error(`additional ECU id "${ecu.id}" must be 7E9..7EF (7E8 is the engine ECU)`);
    }
    return ecu;
}

export class SimulatorEngine {
    readonly profile: VehicleProfile;
    private readonly model: DrivingModel;
    private readonly now: () => number;
    private readonly random: () => number;
    private readonly startedAt: number;
    private readonly logger: SimulatorLogger;
    private readonly latencyFor: ((command: string) => number) | null;
    private readonly ecus: readonly Ecu[];
    private readonly monitorMids: Set<number>;
    private persona: AdapterPersona;
    private link: LinkState;
    private stored: string[];
    private pending: string[];
    private permanent: string[];
    // Sensor snapshot captured when the first stored DTC appears; served via
    // mode 02 until a mode 04 clear. pid → encoded data bytes.
    private freezeFrame: Map<number, number[]> | null = null;

    constructor(options: SimulatorEngineOptions = {}) {
        this.profile = options.profile ?? GASOLINE_PROFILE;
        this.model = options.model ?? new DefaultDrivingModel();
        this.now = options.now ?? Date.now;
        this.random = mulberry32(options.seed ?? 42);
        this.startedAt = this.now();
        this.logger = options.logger ?? {};
        this.latencyFor = options.latencyFor ?? null;
        this.persona = options.adapter ?? DEFAULT_ADAPTER;
        this.link = resetLinkState(this.persona);
        this.ecus = [this.engineEcu(), ...(this.profile.additionalEcus ?? []).map((ecu) => this.additionalEcu(validateEcuProfile(ecu)))];
        this.monitorMids = new Set(this.profile.monitorTests.map((t) => t.mid));
        this.stored = (this.profile.storedDtcs ?? []).map(normalizeDtc);
        this.pending = (this.profile.pendingDtcs ?? []).map(normalizeDtc);
        this.permanent = (this.profile.permanentDtcs ?? []).map(normalizeDtc);
        if (this.stored.length > 0) this.captureFreezeFrame();
    }

    private engineEcu(): Ecu {
        const profile = this.profile;
        const performance = {infotype: profile.ignition === 'spark' ? 0x08 : 0x0b, counters: profile.performanceCounters};
        return {
            id: ENGINE_ECU_ID,
            isEngine: true,
            // Status/readiness PIDs are always served in addition to the signal set.
            pids: new Set([0x01, 0x41, ...profile.pids]),
            readinessSinceClear: profile.readinessSinceClear,
            readinessThisDriveCycle: profile.readinessThisDriveCycle,
            dtcReply: 'list',
            info: {
                id: ENGINE_ECU_ID,
                vin: profile.vin,
                calibrationId: profile.calibrationId,
                cvn: profile.cvn,
                performance,
                name: profile.ecuName,
            },
        };
    }

    private additionalEcu(ecu: EcuProfile): Ecu {
        const readiness = ecu.readiness ?? ZERO_READINESS;
        return {
            id: ecu.id,
            isEngine: false,
            // Status PIDs come with mode 01; an ECU without any signal PID
            // (a module that only rejects DTC requests) stays silent on 01.
            pids: new Set(ecu.pids.length > 0 ? [0x01, 0x41, ...ecu.pids] : []),
            readinessSinceClear: readiness,
            readinessThisDriveCycle: readiness,
            dtcReply: ecu.dtcReply ?? 'empty',
            info: {id: ecu.id, calibrationId: ecu.calibrationId, cvn: ecu.cvn, name: ecu.name},
        };
    }

    get adapter(): AdapterPersona {
        return this.persona;
    }

    // Snapshot of the AT-level settings (echo, headers, spaces, ATST, ...).
    get linkState(): Readonly<LinkState> {
        return this.link;
    }

    // Swaps the adapter persona without resetting link settings — the
    // "same clone, different day" scenario. ATZ applies the new defaults.
    setAdapter(persona: AdapterPersona): void {
        this.persona = persona;
        this.logger.info?.(`adapter persona → ${persona.name}`);
    }

    // Plants a fault code at runtime; stored codes also snapshot the freeze
    // frame the first time one appears. Throws on malformed codes.
    injectDtc(rawCode: string, status: DtcStatus = 'stored'): void {
        const code = normalizeDtc(rawCode);
        const list = status === 'pending' ? this.pending : status === 'permanent' ? this.permanent : this.stored;
        if (list.includes(code)) return;
        if (status === 'pending') this.pending = [...this.pending, code];
        else if (status === 'permanent') this.permanent = [...this.permanent, code];
        else {
            this.stored = [...this.stored, code];
            this.captureFreezeFrame();
        }
        this.logger.info?.(`injected ${code} (${status})`);
    }

    get storedDtcs(): readonly string[] {
        return this.stored;
    }

    // Handles one full command and returns the printed lines joined with the
    // link's line ending (without the blank line + '>' prompt).
    handleCommand(rawCommand: string): string {
        return this.execute(rawCommand).response;
    }

    // Wraps text the way the adapter prints a response: blank line + prompt,
    // with the current line ending. Transports use it for their own output.
    wireFor(text: string): string {
        const eol = this.eol();
        return `${text}${eol}${eol}>`;
    }

    // Same as handleCommand, plus the exact wire bytes and the latency model.
    // When echo is on (before ATE0) the command is echoed as typed, exactly
    // like real hardware.
    execute(rawCommand: string): CommandResult {
        // Real ELM327s ignore whitespace inside commands ('010C 1' ≡ '010C1').
        const command = rawCommand.replace(/\s+/g, '').toUpperCase();
        const echo = this.link.echo ? rawCommand.replace(/[\r\n]/g, '') : null;
        const outcome = this.respond(command);
        const latency = this.latencyOf(command, outcome);
        const eol = this.eol();
        const response = [...(echo === null ? [] : [echo]), ...outcome.lines].join(eol);
        this.logger.debug?.(`${command} -> ${outcome.lines.join('|')} (+${latency.totalMs}ms)`);
        return {command, response, wire: this.wireFor(response), latency};
    }

    private eol(): string {
        return this.link.linefeeds ? '\r\n' : '\r';
    }

    private latencyOf(command: string, outcome: Outcome): CommandResult['latency'] {
        const waitMs = waitMsFor(outcome, this.link, this.persona);
        const searchMs = outcome.searched ? (this.persona.protocolSearchMs ?? 0) : 0;
        const baseMs = this.latencyFor ? this.latencyFor(command) : this.persona.baseLatencyMs;
        const jitterMs =
            this.latencyFor || this.persona.latencyJitterMs === 0 ? 0 : Math.round(this.jitter(this.persona.latencyJitterMs));
        return {baseMs, jitterMs, waitMs, searchMs, totalMs: Math.max(0, baseMs + jitterMs + waitMs + searchMs)};
    }

    // Computes the outcome and applies the link state it carries — the one
    // place state changes (AT settings, protocol search) land.
    private respond(command: string): Outcome {
        const outcome = this.outcomeOf(command);
        this.link = outcome.state;
        return outcome;
    }

    private outcomeOf(command: string): Outcome {
        const none = {hint: null, responders: 0, searched: false, state: this.link};
        if (command.startsWith('AT')) {
            const at = handleAtCommand(command, {
                persona: this.persona,
                state: this.link,
                vehicleProtocol: this.vehicleProtocol(),
                voltage: () => this.voltage(),
                ignitionOn: () => (this.modelValue(0x0c) ?? 0) > 0,
            });
            return {...none, lines: at.lines, kind: at.lines[0] === '?' ? 'unknown' : 'at', state: at.state};
        }
        const st = handleStCommand(command, this.persona);
        if (st !== null) return {...none, lines: [st], kind: st === '?' ? 'unknown' : 'at'};

        // A trailing odd hex digit is the expected-response-count hint.
        const hint = command.length % 2 === 1 ? Number.parseInt(command.slice(-1), 16) : null;
        const request = hint === null ? command : command.slice(0, -1);
        if (!HEX_REQUEST.test(request) || (hint !== null && Number.isNaN(hint))) return {...none, lines: ['?'], kind: 'unknown'};
        return this.respondObdRequest(request, hint);
    }

    // Protocol search (auto mode, first request): SEARCHING... precedes the
    // answer and the search is locked in only once some ECU actually
    // answered — a probe nobody answers (unknown PID, physical address of a
    // module that does not exist) prints UNABLE TO CONNECT and searches again
    // next time, exactly like hardware.
    private respondObdRequest(request: string, hint: number | null): Outcome {
        const addressed = this.addressed(this.respondObd(request));
        const searched = this.link.protocol === AUTO_PROTOCOL && !this.link.searched && this.persona.protocolSearchMs !== null;
        const preamble = searched ? ['SEARCHING...'] : [];
        const state = searched && addressed.length > 0 ? {...this.link, searched: true} : this.link;
        if (searched && addressed.length === 0) {
            return {lines: [...preamble, 'UNABLE TO CONNECT'], kind: 'obd', hint, responders: 0, searched, state};
        }
        const truncated =
            this.persona.honorsResponseHint && hint !== null && hint < addressed.length ? addressed.slice(0, hint) : addressed;
        const lines =
            truncated.length === 0
                ? ['NO DATA']
                : formatLines(truncated, {
                      headers: this.link.headers,
                      spaces: this.link.spaces,
                      extended: isExtended(this.effectiveProtocol()),
                      interleave: !this.persona.batch.multiFrameClean,
                  });
        return {lines: [...preamble, ...lines], kind: 'obd', hint, responders: addressed.length, searched, state};
    }

    private vehicleProtocol(): CanProtocol {
        return this.profile.protocol ?? DEFAULT_PROTOCOL;
    }

    // Forced protocol (ATSPx) or, in auto mode, what the vehicle speaks.
    private effectiveProtocol(): string {
        return this.link.protocol === AUTO_PROTOCOL ? this.vehicleProtocol() : this.link.protocol;
    }

    // Applies the request header (ATSH) and receive filter (ATCRA) to the
    // responses, keeping ECU order.
    private addressed(responses: readonly EcuResponse[]): EcuResponse[] {
        const ids = addressedEcus(
            this.ecus.map((ecu) => ecu.id),
            {requestHeader: this.link.requestHeader, receiveFilter: this.link.receiveFilter, extended: isExtended(this.effectiveProtocol())},
        );
        return responses.filter((response) => ids.includes(response.ecu));
    }

    // [] → NO DATA. Services the vehicle does not implement are rejected
    // with 7F <sid> 11 (service not supported) by every ECU that answers
    // requests at all, so a physically addressed module rejects too.
    private respondObd(request: string): EcuResponse[] {
        const service = request.slice(0, 2);
        const argument = request.slice(2);
        switch (service) {
            case '01':
                return this.respondMode01(argument);
            case '02':
                return this.respondMode02(argument);
            case '03':
                return this.respondDtcRead(0x03, this.stored);
            case '04':
                return this.respondDtcClear();
            case '06':
                return this.respondMode06(argument);
            case '07':
                return this.respondDtcRead(0x07, this.pending);
            case '09':
                return mode09Responses(
                    this.ecus.map((ecu) => ecu.info),
                    argument,
                );
            case '0A':
                if (this.profile.supportsPermanentDtcs === false) return [];
                return this.respondDtcRead(0x0a, this.permanent);
            default:
                return this.ecus
                    .filter((ecu) => ecu.dtcReply !== 'none')
                    .map((ecu) => ({ecu: ecu.id, payload: [NEGATIVE_RESPONSE, Number.parseInt(service, 16), NRC_SERVICE_NOT_SUPPORTED]}));
        }
    }

    // Mode 01: single and batch requests, support-mask queries, one response
    // per ECU that serves any of the requested PIDs.
    private respondMode01(pidsHex: string): EcuResponse[] {
        if (pidsHex.length === 0) return [];
        const pids = hexToBytes(pidsHex);
        const {batch} = this.persona;
        if (pids.length > 1 && (!batch.supported || pids.length > batch.maxPids)) return [];
        return this.ecus.flatMap((ecu) => {
            const body = pids.flatMap((pid) => {
                const data = this.mode01Data(ecu, pid);
                return data ? [pid, ...data] : [];
            });
            return body.length > 0 ? [{ecu: ecu.id, payload: [0x41, ...body]}] : [];
        });
    }

    private mode01Data(ecu: Ecu, pid: number): number[] | null {
        if (pid % MASK_BLOCK === 0 && pid <= LAST_MASK_BASE) {
            // An ECU answers a mask block only when it serves a PID beyond
            // the base — so a module without mode 01 stays silent on 0100.
            const advertised = [...ecu.pids].some((served) => served > pid);
            return advertised ? hexToBytes(maskBytesFor(ecu.pids, pid)) : null;
        }
        if (!ecu.pids.has(pid)) return null;
        if (pid === 0x01) {
            const count = ecu.isEngine ? Math.min(this.stored.length, MAX_DTC_COUNT) : 0;
            const [b, c, d] = ecu.readinessSinceClear;
            return [count > 0 ? MIL_BIT | count : 0, b, c, d];
        }
        if (pid === 0x41) {
            const [b, c, d] = ecu.readinessThisDriveCycle;
            return [0, b, c, d];
        }
        return this.encodeCurrentValue(ecu, pid);
    }

    // Requests are '02 <pid> 00'; only frame 0 exists. PID 00 serves the
    // support mask of the snapshot, PID 02 the DTC that froze the frame
    // (zeros when none did — from every ECU that keeps a code list).
    private respondMode02(argument: string): EcuResponse[] {
        if (argument.length !== 4 || argument.slice(2) !== '00') return [];
        const pid = Number.parseInt(argument.slice(0, 2), 16);
        return this.ecus.flatMap((ecu) => {
            const data = ecu.isEngine ? this.engineFreezeFrameData(pid) : ecu.dtcReply === 'empty' && pid === 0x02 ? [0, 0] : null;
            return data ? [{ecu: ecu.id, payload: [0x42, pid, 0x00, ...data]}] : [];
        });
    }

    private engineFreezeFrameData(pid: number): number[] | null {
        const snapshot = this.stored.length > 0 ? this.freezeFrame : null;
        if (pid % MASK_BLOCK === 0 && pid <= LAST_MASK_BASE) {
            const ids = new Set([...(snapshot?.keys() ?? []), 0x02]);
            return hexToBytes(maskBytesFor(ids, pid));
        }
        if (pid === 0x02) {
            const pair = snapshot ? encodeDtc(this.stored[0]) : null;
            return pair ? [pair[0], pair[1]] : [0, 0];
        }
        return snapshot?.get(pid) ?? null;
    }

    // Mode 06 — the engine ECU serves the profile's monitor test records:
    // mask queries from their MID set, one 9-byte record per (mid, tid).
    private respondMode06(argument: string): EcuResponse[] {
        const mid = Number.parseInt(argument.slice(0, 2), 16);
        if (argument.length !== 2 || Number.isNaN(mid)) return [];
        const engine = {ecu: ENGINE_ECU_ID};
        if (mid % MASK_BLOCK === 0 && mid <= LAST_MASK_BASE) {
            return [{...engine, payload: [0x46, mid, ...hexToBytes(maskBytesFor(this.monitorMids, mid))]}];
        }
        const records = this.profile.monitorTests.filter((t) => t.mid === mid);
        if (records.length === 0) return [];
        const word = (value: number) => [Math.floor(value / 256) & 0xff, value & 0xff];
        const body = records.flatMap((t) => [t.mid, t.tid, t.uasId, ...word(t.value), ...word(t.min), ...word(t.max)]);
        return [{...engine, payload: [0x46, ...body]}];
    }

    // Modes 03/07/0A: the engine ECU lists its codes (count byte, then the
    // pairs); other ECUs answer per their profile.
    private respondDtcRead(service: number, codes: readonly string[]): EcuResponse[] {
        const pairs = codes.map(encodeDtc).filter((pair): pair is [number, number] => pair !== null);
        return this.ecus.flatMap((ecu) => {
            switch (ecu.dtcReply) {
                case 'list':
                    return [{ecu: ecu.id, payload: [service + 0x40, pairs.length, ...pairs.flat()]}];
                case 'empty':
                    return [{ecu: ecu.id, payload: [service + 0x40, 0]}];
                case 'reject':
                    return [{ecu: ecu.id, payload: [NEGATIVE_RESPONSE, service, NRC_GENERAL_REJECT]}];
                default:
                    return [];
            }
        });
    }

    // Mode 04 clears stored + pending codes and the freeze frame; permanent
    // codes survive (only the vehicle erases them after a verified repair).
    private respondDtcClear(): EcuResponse[] {
        this.stored = [];
        this.pending = [];
        this.freezeFrame = null;
        return this.ecus.flatMap((ecu) => {
            if (ecu.dtcReply === 'none') return [];
            if (ecu.dtcReply === 'reject') return [{ecu: ecu.id, payload: [NEGATIVE_RESPONSE, 0x04, NRC_GENERAL_REJECT]}];
            return [{ecu: ecu.id, payload: [0x44]}];
        });
    }

    private captureFreezeFrame(): void {
        if (this.freezeFrame) return;
        const engine = this.ecus[0];
        const snapshot = new Map<number, number[]>();
        for (const pid of this.profile.pids) {
            const data = this.encodeCurrentValue(engine, pid);
            if (data) snapshot.set(pid, data);
        }
        this.freezeFrame = snapshot;
    }

    private voltage(): string {
        const rpm = this.modelValue(0x0c) ?? 0;
        const base = rpm > 400 ? 14.1 : 12.4;
        return `${(base + this.jitter(0.15)).toFixed(1)}V`;
    }

    private encodeCurrentValue(ecu: Ecu, pid: number): number[] | null {
        if (!ecu.pids.has(pid)) return null;
        const encoder = PID_ENCODERS[pid];
        if (!encoder) return null;
        const value = this.modelValue(pid);
        if (value === null) return null;
        return encoder.encode(value);
    }

    private modelValue(pid: number): number | null {
        const elapsedSeconds = Math.max(0, (this.now() - this.startedAt) / 1000);
        return this.model.value(pid, elapsedSeconds, (amplitude) => this.jitter(amplitude));
    }

    private jitter(amplitude: number): number {
        return (this.random() * 2 - 1) * amplitude;
    }
}

// Re-exported for consumers that build expected output by hand.
export {toHex};
