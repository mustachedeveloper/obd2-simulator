import type {
    AdapterFault,
    AdapterPersona,
    CanProtocol,
    CommandResult,
    DrivingModel,
    DtcStatus,
    EngineSnapshot,
    IgnitionState,
    LinkState,
    SetIgnitionOptions,
    SimulatorLogger,
    VehicleProfile,
} from './types';
import {DefaultDrivingModel} from './DefaultDrivingModel';
import {mulberry32} from './prng';
import {PID_ENCODERS, encodeDtc, maskBytesFor, normalizeDtc, toHex} from './j1979';
import {GASOLINE_PROFILE, gasolineDrivingModel} from '../profiles/gasoline';
import {DEFAULT_ADAPTER} from '../adapters/presets';
import {AUTO_PROTOCOL, bannerLines, handleAtCommand, handleStCommand, resetLinkState} from './at-commands';
import {canFrames, formatLines, hexToBytes, type EcuResponse} from './framing';
import {encodeGearReport, gearFor} from './gear';
import {ENGINE_ECU_ID, addressedEcus, isExtended, type SourceAddresses} from './ecus';
import {type Ecu, sourceAddressesOf, validateFramePadding, vehicleEcus} from './vehicle-ecus';
import {mode09Responses} from './mode09';
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
const NRC_RESPONSE_PENDING = 0x78;
const CLEAR_PAYLOADS = {
    positive: [0x44],
    pending: [NEGATIVE_RESPONSE, 0x04, NRC_RESPONSE_PENDING],
    reject: [NEGATIVE_RESPONSE, 0x04, NRC_GENERAL_REJECT],
} as const;
const MIL_BIT = 0x80;
const MAX_DTC_COUNT = 0x7f;
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
const GEAR_PID = 0xa4;
const STOPPED = 'STOPPED';
// How long the vLinker took to print STOPPED after a search was cut short.
const SEARCH_ABORT_MS = 670;
const RESET_COMMANDS: ReadonlySet<string> = new Set(['ATZ', 'ATWS']);
const SILENCE = {
    response: '',
    wire: '',
    latency: {baseMs: 0, jitterMs: 0, waitMs: 0, searchMs: 0, totalMs: 0},
    silent: true,
} as const;
// Recorded after the engine stopped: 12.4–12.5 V on the vLinkers.
const VOLTAGE = {off: 12.4, keyOn: 12.4, running: 14.1, cranked: 400};
interface Outcome {
    /**
     * The adapter drops the command: nothing is printed, not even the prompt.
     */
    silent?: boolean;
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

export class SimulatorEngine {
    readonly profile: VehicleProfile;
    private readonly model: DrivingModel;
    private readonly now: () => number;
    private readonly random: () => number;
    private readonly startedAt: number;
    private readonly logger: SimulatorLogger;
    private readonly latencyFor: ((command: string) => number) | null;
    private readonly ecus: readonly Ecu[];
    private readonly sources: SourceAddresses;
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
    // End of the engine ECU's after-run phase (clock of `now`); null → none.
    private afterRunUntil: number | null = null;
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
        this.ecus = vehicleEcus(this.profile);
        this.sources = sourceAddressesOf(this.profile);
        this.monitorMids = new Set(this.profile.monitorTests.map((t) => t.mid));
        this.stored = (this.profile.storedDtcs ?? []).map(normalizeDtc);
        this.pending = (this.profile.pendingDtcs ?? []).map(normalizeDtc);
        this.permanent = (this.profile.permanentDtcs ?? []).map(normalizeDtc);
        if (this.stored.length > 0) this.captureFreezeFrame();
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
     *
     * @throws if `afterRunMs` is negative, not finite, or given with a state other than 'off'.
     */
    setIgnition(state: IgnitionState, options: SetIgnitionOptions = {}): void {
        const afterRunMs = options.afterRunMs ?? 0;
        if (!Number.isFinite(afterRunMs) || afterRunMs < 0)
            throw new Error(`afterRunMs must be a non-negative number, got ${afterRunMs}`);
        if (afterRunMs > 0 && state !== 'off') throw new Error(`afterRunMs only applies to ignition 'off', got '${state}'`);
        this.ignitionState = state;
        this.afterRunUntil = afterRunMs > 0 ? this.now() + afterRunMs : null;
        this.logger.info?.(`ignition → ${state}${afterRunMs > 0 ? ` (after-run ${afterRunMs} ms)` : ''}`);
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
        this.afterRunUntil = null;
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
     * What the adapter does when `rawCommand` arrives while `aborted` is
     * still in progress: the running command is dropped, STOPPED is printed
     * and the new command is not executed. An aborted protocol search is
     * not locked in, so the next request searches again. Transports that
     * model interruption call this instead of execute().
     */
    interrupt(aborted: CommandResult, rawCommand: string): CommandResult {
        const searching = aborted.latency.searchMs > 0;
        if (searching) this.link = {...this.link, searched: false};
        const baseMs = searching ? SEARCH_ABORT_MS : this.persona.baseLatencyMs;
        const latency = {baseMs, jitterMs: 0, waitMs: 0, searchMs: 0, totalMs: baseMs};
        const command = rawCommand.replace(/\s+/g, '').toUpperCase();
        const result = {command, response: STOPPED, wire: this.wireFor(STOPPED), latency, silent: false};
        this.logger.debug?.(`${command} -> ${STOPPED} (aborted ${aborted.command})`);
        for (const listener of this.commandListeners) listener(result);
        return result;
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
        const result = outcome.silent ? {command, ...SILENCE} : this.printed(command, echo, outcome);
        this.logger.debug?.(
            `${command} -> ${outcome.silent ? '(silence)' : outcome.lines.join('|')} (+${result.latency.totalMs}ms)`,
        );
        for (const listener of this.commandListeners) listener(result);
        return result;
    }

    private printed(command: string, echo: string | null, outcome: Outcome): CommandResult {
        const latency = this.latencyOf(command, outcome);
        const response = [...(echo === null ? [] : [echo]), ...outcome.lines].join(this.eol());
        return {command, response, wire: this.wireFor(response), latency, silent: false};
    }

    private eol(): string {
        return this.link.linefeeds ? '\r\n' : '\r';
    }

    private latencyOf(command: string, outcome: Outcome): CommandResult['latency'] {
        const waitMs = waitMsFor(outcome, this.link, this.persona);
        const searchMs = outcome.searched ? this.searchMsFor(outcome) : 0;
        const baseMs = this.latencyFor ? this.latencyFor(command) : this.baseMsFor(command, outcome);
        const jitterMs =
            this.latencyFor || this.persona.latencyJitterMs === 0 ? 0 : Math.round(this.jitter(this.persona.latencyJitterMs));
        return {baseMs, jitterMs, waitMs, searchMs, totalMs: Math.max(0, baseMs + jitterMs + waitMs + searchMs)};
    }

    // A search nobody answers runs through every protocol before giving up.
    private searchMsFor(outcome: Outcome): number {
        const found = this.persona.protocolSearchMs ?? 0;
        return outcome.responders === 0 ? (this.persona.protocolSearchFailMs ?? found) : found;
    }

    private baseMsFor(command: string, outcome: Outcome): number {
        const {baseLatencyMs, atLatencyMs = baseLatencyMs, resetLatencyMs = atLatencyMs} = this.persona;
        if (RESET_COMMANDS.has(command)) return resetLatencyMs;
        return outcome.kind === 'at' ? atLatencyMs : baseLatencyMs;
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
        if (this.dropsSilently(request)) return {...none, silent: true, lines: [], kind: 'obd', hint};
        return this.respondObdRequest(request, hint);
    }

    // A mode 01 request with more PIDs than the adapter handles, on an
    // adapter that answers those with nothing at all.
    private dropsSilently(request: string): boolean {
        const {batch} = this.persona;
        return batch.overflow === 'silent' && request.startsWith('01') && request.length / 2 - 1 > batch.maxPids;
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
        const honored = this.persona.honorsResponseHint && hint !== null;
        const countsFrames = honored && this.persona.hintCountsFrames === true;
        // A zero hint awaits nothing, whatever the adapter counts.
        const awaited = honored && (countsFrames ? hint === 0 : hint < addressed.length) ? addressed.slice(0, hint) : addressed;
        const lines =
            awaited.length === 0
                ? ['NO DATA']
                : formatLines(awaited, {
                      headers: this.link.headers,
                      spaces: this.link.spaces,
                      extended: isExtended(this.effectiveProtocol()),
                      interleave: !this.persona.batch.multiFrameClean,
                      padding: this.profile.framePadding,
                      trimSegments: this.persona.trimsFramePadding === true,
                      padSingleFrames: this.persona.padsSingleFrames === true,
                      trimRawSingleFrames: this.persona.trimsRawSingleFrames === true,
                      sources: this.sources,
                      ...(countsFrames ? {maxFrames: hint} : {}),
                  });
        // What the hint is measured against: frames for a frame-counting adapter.
        const responders = countsFrames
            ? addressed.reduce((sum, response) => sum + canFrames(response.payload).length, 0)
            : addressed.length;
        return {lines: [...preamble, ...lines], kind: 'obd', hint, responders, searched, state};
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
                sources: this.sources,
            },
        );
        return responses.filter((response) => ids.includes(response.ecu));
    }

    // [] → NO DATA. Services the vehicle does not implement are rejected
    // with 7F <sid> 11 (service not supported) by every ECU that answers
    // requests at all, so a physically addressed module rejects too.
    private respondObd(request: string): EcuResponse[] {
        const service = request.slice(0, 2);
        if (this.ignitionState === 'off') return this.inAfterRun() ? this.afterRunRejection(service) : [];
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

    private inAfterRun(): boolean {
        return this.afterRunUntil !== null && this.now() < this.afterRunUntil;
    }

    // Engine just stopped: its ECU is still awake and refuses whatever it is
    // asked (conditions not correct); every other module is already silent.
    private afterRunRejection(service: string): EcuResponse[] {
        return [{ecu: ENGINE_ECU_ID, payload: [NEGATIVE_RESPONSE, Number.parseInt(service, 16), NRC_CONDITIONS_NOT_CORRECT]}];
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
        const answering = this.ecus.filter((ecu) => ecu.clearReply !== 'none');
        if (this.profile.clearRequiresEngineOff && this.ignitionState === 'running') {
            return answering.map((ecu) => ({ecu: ecu.id, payload: [NEGATIVE_RESPONSE, 0x04, NRC_CONDITIONS_NOT_CORRECT]}));
        }
        this.stored = [];
        this.pending = [];
        this.freezeFrame = null;
        return answering.flatMap((ecu) =>
            ecu.clearReply === 'none' ? [] : [{ecu: ecu.id, payload: [...CLEAR_PAYLOADS[ecu.clearReply]]}],
        );
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
        return `${(base + (this.persona.voltageOffsetV ?? 0) + this.jitter(0.15)).toFixed(1)}V`;
    }

    private encodeCurrentValue(ecu: Ecu, pid: number): number[] | null {
        if (!ecu.pids.has(pid)) return null;
        if (pid === GEAR_PID && this.profile.transmissionPid === 'gear') return this.gearReport();
        const encoder = PID_ENCODERS[pid];
        if (!encoder) return null;
        const value = this.modelValue(pid);
        if (value === null) return null;
        return encoder.encode(value);
    }

    // An override of the PID is the gear itself; otherwise it follows from
    // engine and road speed (overrides of those included).
    private gearReport(): number[] | null {
        if (this.overridesMap.has(GEAR_PID)) {
            const pinned = this.overridesMap.get(GEAR_PID) ?? null;
            return pinned === null ? null : encodeGearReport(pinned);
        }
        return encodeGearReport(gearFor(this.modelValue(0x0c) ?? 0, this.modelValue(0x0d) ?? 0));
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
