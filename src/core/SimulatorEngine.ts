import type {
    AdapterFault,
    AdapterPersona,
    CanProtocol,
    CommandResult,
    DrivingModel,
    DtcStatus,
    EcuProfile,
    EngineSnapshot,
    IgnitionState,
    LinkState,
    ReadinessBytes,
    SimulatorLogger,
    VehicleProfile,
} from './types';
import {DefaultDrivingModel} from './DefaultDrivingModel';
import {mulberry32} from './prng';
import {PID_ENCODERS, encodeDtc, maskBytesFor, normalizeDtc, toHex} from './j1979';
import {GASOLINE_PROFILE, gasolineDrivingModel} from '../profiles/gasoline';
import {DEFAULT_ADAPTER} from '../adapters/presets';
import {AUTO_PROTOCOL, bannerLines, handleAtCommand, handleStCommand, resetLinkState} from './at-commands';
import {formatLines, hexToBytes, type EcuResponse} from './framing';
import {ADDITIONAL_ECU_ID, ENGINE_ECU_ID, addressedEcus, isExtended} from './ecus';
import {mode09Responses, type VehicleInfoSource} from './mode09';
import {checkQueueCount, isPid, parseSnapshot} from './snapshot';
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
    /**
     * Default: the default gasoline vehicle.
     */
    profile?: VehicleProfile;
    /**
     * Default: the default vehicle's recorded drive when no `profile` is
     * given either, otherwise the synthetic cycle (`DefaultDrivingModel`).
     */
    model?: DrivingModel;
    adapter?: AdapterPersona;
    /**
     * Injectable clock for deterministic tests; defaults to Date.now.
     */
    now?: () => number;
    seed?: number;
    logger?: SimulatorLogger;
    /**
     * Replaces the persona's base + jitter latency (e.g. a distribution
     * derived from a recorded wire log). The ATST wait is still added.
     */
    latencyFor?: (command: string) => number;
}

const MASK_BLOCK = 0x20;
const LAST_MASK_BASE = 0xa0;
const DEFAULT_PROTOCOL: CanProtocol = '6';
const HEX_REQUEST = /^([0-9A-F]{2})+$/;
const NEGATIVE_RESPONSE = 0x7f;
const NRC_GENERAL_REJECT = 0x10;
const NRC_CONDITIONS_NOT_CORRECT = 0x22;
const NRC_SERVICE_NOT_SUPPORTED = 0x11;
const MIL_BIT = 0x80;
const MAX_DTC_COUNT = 0x7f;
const ZERO_READINESS: ReadinessBytes = [0, 0, 0];
// Key on, engine off: the moving parts read zero, the battery carries the bus.
const KEY_ON_VALUES: Readonly<Record<number, number>> = {
    0x04: 0,
    0x0c: 0,
    0x0d: 0,
    0x10: 0,
    0x1f: 0,
    0x42: 12.4,
    0x43: 0,
    0x5e: 0,
    0x61: 0,
    0x62: 0,
};
const VOLTAGE = {off: 12.2, keyOn: 12.4, running: 14.1, cranked: 400};
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
    /**
     * A protocol search ran for this command (SEARCHING... printed).
     */
    searched: boolean;
    /**
     * Link settings after the command; respond() applies it.
     */
    state: LinkState;
}

function validateEcuProfile(ecu: EcuProfile): EcuProfile {
    if (!ADDITIONAL_ECU_ID.test(ecu.id)) {
        throw new Error(`additional ECU id "${ecu.id}" must be 7E9..7EF (7E8 is the engine ECU)`);
    }
    return ecu;
}

function validateFramePadding(padding: number | undefined): void {
    if (padding !== undefined && !(Number.isInteger(padding) && padding >= 0 && padding <= 0xff)) {
        throw new Error(`framePadding must be a byte (0..255), got ${padding}`);
    }
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
    // Scenario controls: pinned PID values, power state, queued adapter errors.
    private overridesMap = new Map<number, number | null>();
    private ignitionState: IgnitionState = 'running';
    private faults: AdapterFault[] = [];
    private readonly commandListeners = new Set<(result: CommandResult) => void>();

    constructor(options: SimulatorEngineOptions = {}) {
        this.profile = options.profile ?? GASOLINE_PROFILE;
        validateFramePadding(this.profile.framePadding);
        // No profile → the default simulator, vehicle and recorded drive
        // together. A profile without a model always gets the synthetic
        // cycle, whatever the profile is: pairing a vehicle with its own
        // model is what createSimulator() is for.
        this.model = options.model ?? (options.profile ? new DefaultDrivingModel() : gasolineDrivingModel());
        this.now = options.now ?? Date.now;
        this.random = mulberry32(options.seed ?? 42);
        this.startedAt = this.now();
        this.logger = options.logger ?? {};
        this.latencyFor = options.latencyFor ?? null;
        this.persona = options.adapter ?? DEFAULT_ADAPTER;
        this.link = resetLinkState(this.persona);
        this.ecus = [
            this.engineEcu(),
            ...(this.profile.additionalEcus ?? []).map((ecu) => this.additionalEcu(validateEcuProfile(ecu))),
        ];
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
            /**
             * Status/readiness PIDs are always served in addition to the signal set.
             */
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
            /**
             * Status PIDs come with mode 01; an ECU without any signal PID
             * (a module that only rejects DTC requests) stays silent on 01.
             */
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

    /**
     * Snapshot of the AT-level settings (echo, headers, spaces, ATST, ...).
     */
    get linkState(): Readonly<LinkState> {
        return this.link;
    }

    /**
     * Swaps the adapter persona without resetting link settings — the
     * "same clone, different day" scenario. ATZ applies the new defaults.
     */
    setAdapter(persona: AdapterPersona): void {
        this.persona = persona;
        this.logger.info?.(`adapter persona → ${persona.name}`);
    }

    /**
     * Plants a fault code at runtime; stored codes also snapshot the freeze
     * frame the first time one appears. Throws on malformed codes.
     */
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

    get pendingDtcs(): readonly string[] {
        return this.pending;
    }

    get permanentDtcs(): readonly string[] {
        return this.permanent;
    }

    /**
     * Drops a code from whichever list holds it. Throws on malformed codes.
     */
    removeDtc(rawCode: string): void {
        const code = normalizeDtc(rawCode);
        this.stored = this.stored.filter((c) => c !== code);
        this.pending = this.pending.filter((c) => c !== code);
        this.permanent = this.permanent.filter((c) => c !== code);
        if (this.stored.length === 0) this.freezeFrame = null;
    }

    /**
     * Test-side reset of every list (unlike mode 04, permanent codes go too).
     */
    clearDtcs(): void {
        this.stored = [];
        this.pending = [];
        this.permanent = [];
        this.freezeFrame = null;
    }

    /**
     * Pins a mode 01 PID to a physical value (null → NO DATA) regardless of
     * the driving model; freeze frames capture the pinned value too.
     */
    override(pid: number, value: number | null): void {
        if (!isPid(pid)) throw new Error(`override: PID must be an integer in 0-255, got ${pid}`);
        if (value !== null && !Number.isFinite(value))
            throw new Error(`override: value must be a finite number or null, got ${value}`);
        this.overridesMap = new Map([...this.overridesMap, [pid, value]]);
    }

    clearOverride(pid: number): void {
        this.overridesMap = new Map([...this.overridesMap].filter(([key]) => key !== pid));
    }

    clearOverrides(): void {
        this.overridesMap = new Map();
    }

    get overrides(): Readonly<Record<number, number | null>> {
        return Object.fromEntries(this.overridesMap);
    }

    /**
     * Key off puts every ECU to sleep (NO DATA / UNABLE TO CONNECT); key on
     * answers with a stopped engine; running is the driving cycle.
     */
    setIgnition(state: IgnitionState): void {
        this.ignitionState = state;
        this.logger.info?.(`ignition → ${state}`);
    }

    get ignition(): IgnitionState {
        return this.ignitionState;
    }

    /**
     * Makes the adapter print an error instead of the next `count` OBD
     * responses (AT commands are unaffected). Faults queue in order.
     */
    failNext(fault: AdapterFault, count = 1): void {
        this.faults = [...this.faults, ...new Array<AdapterFault>(checkQueueCount(count)).fill(fault)];
    }

    clearFaults(): void {
        this.faults = [];
    }

    get pendingFaults(): readonly AdapterFault[] {
        return this.faults;
    }

    /**
     * Power-cycles the adapter: settings back to persona defaults, and the
     * banner the adapter prints unprompted on the wire.
     */
    resetAdapter(): string {
        this.link = resetLinkState(this.persona);
        return this.wireFor(bannerLines(this.persona).join(this.eol()));
    }

    /**
     * Called after every command with its result; returns the unsubscribe.
     */
    onCommand(listener: (result: CommandResult) => void): () => void {
        this.commandListeners.add(listener);
        return () => this.commandListeners.delete(listener);
    }

    snapshot(): EngineSnapshot {
        return {
            link: {...this.link},
            storedDtcs: [...this.stored],
            pendingDtcs: [...this.pending],
            permanentDtcs: [...this.permanent],
            freezeFrame: this.freezeFrame ? [...this.freezeFrame].map(([pid, data]) => [pid, [...data]] as const) : null,
            overrides: this.overrides,
            ignition: this.ignitionState,
            pendingFaults: [...this.faults],
        };
    }

    /**
     * Atomic: a malformed snapshot throws before anything changes.
     */
    restore(snapshot: EngineSnapshot): void {
        const parsed = parseSnapshot(snapshot);
        this.link = parsed.link;
        this.stored = [...parsed.storedDtcs];
        this.pending = [...parsed.pendingDtcs];
        this.permanent = [...parsed.permanentDtcs];
        this.freezeFrame = parsed.freezeFrame ? new Map(parsed.freezeFrame.map(([pid, data]) => [pid, [...data]])) : null;
        this.overridesMap = new Map(Object.entries(parsed.overrides).map(([pid, value]) => [Number(pid), value]));
        this.ignitionState = parsed.ignition;
        this.faults = [...parsed.pendingFaults];
    }

    /**
     * Handles one full command and returns the printed lines joined with the
     * link's line ending (without the blank line + '>' prompt).
     */
    handleCommand(rawCommand: string): string {
        return this.execute(rawCommand).response;
    }

    /**
     * Wraps text the way the adapter prints a response: blank line + prompt,
     * with the current line ending. Transports use it for their own output.
     */
    wireFor(text: string): string {
        const eol = this.eol();
        return `${text}${eol}${eol}>`;
    }

    /**
     * Same as handleCommand, plus the exact wire bytes and the latency model.
     * When echo is on (before ATE0) the command is echoed as typed, exactly
     * like real hardware.
     */
    execute(rawCommand: string): CommandResult {
        // Real ELM327s ignore whitespace inside commands ('010C 1' ≡ '010C1').
        const command = rawCommand.replace(/\s+/g, '').toUpperCase();
        const echo = this.link.echo ? rawCommand.replace(/[\r\n]/g, '') : null;
        const outcome = this.respond(command);
        const latency = this.latencyOf(command, outcome);
        const eol = this.eol();
        const response = [...(echo === null ? [] : [echo]), ...outcome.lines].join(eol);
        this.logger.debug?.(`${command} -> ${outcome.lines.join('|')} (+${latency.totalMs}ms)`);
        const result = {command, response, wire: this.wireFor(response), latency};
        for (const listener of this.commandListeners) listener(result);
        return result;
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
                ignitionOn: () => this.ignitionState !== 'off',
            });
            return {...none, lines: at.lines, kind: at.lines[0] === '?' ? 'unknown' : 'at', state: at.state};
        }
        const st = handleStCommand(command, this.persona);
        if (st !== null) return {...none, lines: [st], kind: st === '?' ? 'unknown' : 'at'};

        // A trailing odd hex digit is the expected-response-count hint.
        const hint = command.length % 2 === 1 ? Number.parseInt(command.slice(-1), 16) : null;
        const request = hint === null ? command : command.slice(0, -1);
        if (!HEX_REQUEST.test(request) || (hint !== null && Number.isNaN(hint))) return {...none, lines: ['?'], kind: 'unknown'};
        const [fault, ...remainingFaults] = this.faults;
        if (fault !== undefined) {
            this.faults = remainingFaults;
            return {...none, lines: [fault], kind: 'fault', hint};
        }
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
                      padding: this.profile.framePadding,
                      trimSegments: this.persona.trimsFramePadding === true,
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
            {
                requestHeader: this.link.requestHeader,
                receiveFilter: this.link.receiveFilter,
                extended: isExtended(this.effectiveProtocol()),
            },
        );
        return responses.filter((response) => ids.includes(response.ecu));
    }

    // [] → NO DATA. Services the vehicle does not implement are rejected
    // with 7F <sid> 11 (service not supported) by every ECU that answers
    // requests at all, so a physically addressed module rejects too.
    private respondObd(request: string): EcuResponse[] {
        if (this.ignitionState === 'off') return [];
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
                    .map((ecu) => ({
                        ecu: ecu.id,
                        payload: [NEGATIVE_RESPONSE, Number.parseInt(service, 16), NRC_SERVICE_NOT_SUPPORTED],
                    }));
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
            const data = ecu.isEngine
                ? this.engineFreezeFrameData(pid)
                : ecu.dtcReply === 'empty' && pid === 0x02
                  ? [0, 0]
                  : null;
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
            const pair = snapshot ? encodeDtc(this.stored[0] ?? '') : null;
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
        if (this.profile.clearRequiresEngineOff && this.ignitionState === 'running') {
            return this.ecus
                .filter((ecu) => ecu.dtcReply !== 'none')
                .map((ecu) => ({ecu: ecu.id, payload: [NEGATIVE_RESPONSE, 0x04, NRC_CONDITIONS_NOT_CORRECT]}));
        }
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
        const [engine] = this.ecus;
        if (!engine) return;
        const snapshot = new Map<number, number[]>();
        for (const pid of this.profile.pids) {
            const data = this.encodeCurrentValue(engine, pid);
            if (data) snapshot.set(pid, data);
        }
        this.freezeFrame = snapshot;
    }

    private voltage(): string {
        const rpm = this.modelValue(0x0c) ?? 0;
        const base = this.ignitionState === 'off' ? VOLTAGE.off : rpm > VOLTAGE.cranked ? VOLTAGE.running : VOLTAGE.keyOn;
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

    // Overrides win, then the power state, then the driving model.
    private modelValue(pid: number): number | null {
        if (this.overridesMap.has(pid)) return this.overridesMap.get(pid) ?? null;
        if (this.ignitionState === 'key-on') {
            const keyOn = KEY_ON_VALUES[pid];
            if (keyOn !== undefined) return keyOn;
            return this.model.value(pid, 0, (amplitude) => this.jitter(amplitude));
        }
        const elapsedSeconds = Math.max(0, (this.now() - this.startedAt) / 1000);
        return this.model.value(pid, elapsedSeconds, (amplitude) => this.jitter(amplitude));
    }

    private jitter(amplitude: number): number {
        return (this.random() * 2 - 1) * amplitude;
    }
}

/**
 * Re-exported for consumers that build expected output by hand.
 */
export {toHex};
