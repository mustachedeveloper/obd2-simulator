import type {
    AdapterPersona,
    CommandResult,
    DrivingModel,
    DtcStatus,
    LinkState,
    SimulatorLogger,
    VehicleProfile,
} from './types';
import {DefaultDrivingModel} from './DefaultDrivingModel';
import {mulberry32} from './prng';
import {PID_ENCODERS, asciiBytes, encodeDtc, maskBytesFor, toHex} from './j1979';
import {GASOLINE_PROFILE} from '../profiles/gasoline';
import {DEFAULT_ADAPTER} from '../adapters/presets';
import {FUNCTIONAL_REQUEST_HEADER, handleAtCommand, handleStCommand, resetLinkState} from './at-commands';
import {formatResponses, hexToBytes, type EcuResponse} from './framing';
import {waitMsFor, type CommandKind} from './timing';

// Wire-level fake vehicle + ELM327 adapter in one object: feed it the exact
// ASCII commands a real adapter receives, get back the exact text a real
// adapter prints (echo behavior, ISO-TP long-response framing, support
// masks) plus the latency the adapter would have taken. Transports
// (in-process link, TCP server) only move these strings and wait.
//
// Simulated surface: AT/ST command set, mode 01 (profile PID set + status
// PIDs 0x01/0x41, batch, multi-ECU), mode 02 freeze frame, modes 03/07/0A
// + 04 DTC lifecycle, mode 06 monitor tests, mode 09 vehicle info. The
// adapter persona decides identity, quirks and timing.

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

const PHYSICAL_HEADER = /^7E([0-7])$/;
// 11-bit and 29-bit functional (broadcast) request headers.
const FUNCTIONAL_HEADERS = new Set([FUNCTIONAL_REQUEST_HEADER, '18DB33F1']);
const MASK_BLOCK = 0x20;
const LAST_MASK_BASE = 0xa0;
const NO_DATA = 'NO DATA';

// Personas are user-constructible; fail loudly on the one shape the engine
// cannot serve instead of printing 'undefined' into CAN frames.
function validatePersona(persona: AdapterPersona): AdapterPersona {
    if (persona.respondingEcus.length === 0) {
        throw new Error(`adapter persona "${persona.name}" needs at least one responding ECU`);
    }
    return persona;
}

export class SimulatorEngine {
    readonly profile: VehicleProfile;
    private readonly model: DrivingModel;
    private readonly now: () => number;
    private readonly random: () => number;
    private readonly startedAt: number;
    private readonly logger: SimulatorLogger;
    private readonly latencyFor: ((command: string) => number) | null;
    private readonly supportedPids: Set<number>;
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
        this.persona = validatePersona(options.adapter ?? DEFAULT_ADAPTER);
        this.link = resetLinkState(this.persona);
        // Status/readiness PIDs are always served in addition to the
        // profile's signal set.
        this.supportedPids = new Set([0x01, 0x41, ...this.profile.pids]);
        this.monitorMids = new Set(this.profile.monitorTests.map((t) => t.mid));
        this.stored = [...(this.profile.storedDtcs ?? [])];
        this.pending = [...(this.profile.pendingDtcs ?? [])];
        this.permanent = [...(this.profile.permanentDtcs ?? [])];
        if (this.stored.length > 0) this.captureFreezeFrame();
    }

    get adapter(): AdapterPersona {
        return this.persona;
    }

    // Snapshot of the AT-level settings (echo, headers, ATST, ...).
    get linkState(): Readonly<LinkState> {
        return this.link;
    }

    // Swaps the adapter persona without resetting link settings — the
    // "same clone, different day" scenario. ATZ applies the new defaults.
    setAdapter(persona: AdapterPersona): void {
        this.persona = validatePersona(persona);
        this.logger.info?.(`adapter persona → ${persona.name}`);
    }

    // Plants a fault code at runtime; stored codes also snapshot the freeze
    // frame the first time one appears.
    injectDtc(code: string, status: DtcStatus = 'stored'): void {
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

    // Handles one full command and returns the payload the adapter would
    // print (without the trailing '>' prompt — the transport appends that).
    handleCommand(rawCommand: string): string {
        return this.execute(rawCommand).response;
    }

    // Same, plus the latency model: how long the adapter would have taken
    // before printing. When echo is on (before ATE0) the command itself is
    // prefixed, exactly like real hardware.
    execute(rawCommand: string): CommandResult {
        // Real ELM327s ignore whitespace inside commands ('010C 1' ≡ '010C1').
        const command = rawCommand.replace(/\s+/g, '').toUpperCase();
        const echoWasEnabled = this.link.echo;
        const outcome = this.respond(command);
        const waitMs = waitMsFor(outcome, this.link, this.persona);
        const baseMs = this.latencyFor ? this.latencyFor(command) : this.persona.baseLatencyMs;
        const jitterMs =
            this.latencyFor || this.persona.latencyJitterMs === 0 ? 0 : Math.round(this.jitter(this.persona.latencyJitterMs));
        const latency = {baseMs, jitterMs, waitMs, totalMs: Math.max(0, baseMs + jitterMs + waitMs)};
        const response = echoWasEnabled ? `${command}\r${outcome.text}` : outcome.text;
        this.logger.debug?.(`${command} -> ${outcome.text} (+${latency.totalMs}ms)`);
        return {command, response, latency};
    }

    private respond(command: string): {text: string; kind: CommandKind; hint: number | null; responders: number} {
        if (command.startsWith('AT')) {
            const at = handleAtCommand(command, {
                persona: this.persona,
                state: this.link,
                voltage: () => this.voltage(),
                ignitionOn: () => (this.modelValue(0x0c) ?? 0) > 0,
            });
            this.link = at.state;
            return {text: at.response, kind: at.response === '?' ? 'unknown' : 'at', hint: null, responders: 0};
        }
        const st = handleStCommand(command, this.persona);
        if (st !== null) return {text: st, kind: st === '?' ? 'unknown' : 'at', hint: null, responders: 0};

        // A trailing odd hex digit is the expected-response-count hint.
        const hint = command.length % 2 === 1 ? Number.parseInt(command.slice(-1), 16) : null;
        const request = hint === null ? command : command.slice(0, -1);
        const responses = this.respondObd(request);
        if (responses === null) return {text: '?', kind: 'unknown', hint, responders: 0};
        const addressed = this.addressed(responses);
        const truncated =
            this.persona.honorsResponseHint && hint !== null && hint < addressed.length ? addressed.slice(0, hint) : addressed;
        const text =
            truncated.length === 0
                ? NO_DATA
                : formatResponses(truncated, {
                      headers: this.link.headers,
                      interleave: !this.persona.batch.multiFrameClean,
                  });
        return {text, kind: 'obd', hint, responders: addressed.length};
    }

    // Applies the request header (ATSH: functional → every ECU, 7E0..7E7 →
    // that ECU only, anything else → nobody listens) and the receive filter
    // (ATCRA) to the set of ECUs that answered.
    private addressed(responses: readonly EcuResponse[]): EcuResponse[] {
        const header = this.link.requestHeader;
        const physical = PHYSICAL_HEADER.exec(header);
        const target = physical ? `7E${(Number.parseInt(physical[1], 16) + 8).toString(16).toUpperCase()}` : null;
        if (target === null && !FUNCTIONAL_HEADERS.has(header)) return [];
        return responses.filter(
            (response) =>
                (target === null || response.ecu === target) &&
                (this.link.receiveFilter === null || response.ecu === this.link.receiveFilter),
        );
    }

    // null → unknown service ('?'); [] → NO DATA.
    private respondObd(command: string): EcuResponse[] | null {
        if (command.startsWith('01')) return this.respondMode01(command.slice(2));
        const single = this.respondSingleEcu(command);
        if (single === null) return null;
        return single === NO_DATA ? [] : [{ecu: this.persona.respondingEcus[0], payload: hexToBytes(single)}];
    }

    private respondSingleEcu(command: string): string | null {
        if (command === '03') return this.respondDtcRead(0x43, this.stored);
        if (command === '07') return this.respondDtcRead(0x47, this.pending);
        if (command === '0A') return this.respondDtcRead(0x4a, this.permanent);
        if (command === '04') return this.respondDtcClear();
        if (command.startsWith('02')) return this.respondMode02(command);
        if (command.startsWith('06')) return this.respondMode06(command);
        if (command.startsWith('09')) return this.respondMode09(command);
        return null;
    }

    // Mode 01: single and batch requests, support-mask queries. The engine
    // ECU serves the whole profile; further ECUs only their PID subset.
    private respondMode01(pidsHex: string): EcuResponse[] {
        if (pidsHex.length === 0 || pidsHex.length % 2 === 1) return [];
        const pids = hexToBytes(pidsHex);
        const {batch} = this.persona;
        if (pids.length > 1 && (!batch.supported || pids.length > batch.maxPids)) return [];

        const responses: EcuResponse[] = [];
        this.persona.respondingEcus.forEach((ecu, index) => {
            const served = index === 0 ? this.supportedPids : this.secondaryEcuPids();
            const payload = this.mode01Payload(pids, served);
            if (payload) responses.push({ecu, payload});
        });
        return responses;
    }

    private secondaryEcuPids(): Set<number> {
        const subset = this.persona.secondEcuPids ?? [];
        return new Set(subset.filter((pid) => this.supportedPids.has(pid)));
    }

    private mode01Payload(pids: readonly number[], served: ReadonlySet<number>): number[] | null {
        let body: number[] = [];
        for (const pid of pids) {
            const data = this.mode01Data(pid, served);
            if (data) body = [...body, pid, ...data];
        }
        return body.length > 0 ? [0x41, ...body] : null;
    }

    private mode01Data(pid: number, served: ReadonlySet<number>): number[] | null {
        if (pid % MASK_BLOCK === 0 && pid <= LAST_MASK_BASE) return hexToBytes(maskBytesFor(served, pid));
        if (!served.has(pid)) return null;
        if (pid === 0x01) {
            const count = Math.min(this.stored.length, 0x7f);
            const [b, c, d] = this.profile.readinessSinceClear;
            return [count > 0 ? 0x80 | count : 0, b, c, d];
        }
        if (pid === 0x41) {
            const [b, c, d] = this.profile.readinessThisDriveCycle;
            return [0, b, c, d];
        }
        return this.encodeCurrentValue(pid);
    }

    // Requests are '02 <pid> 00'; only frame 0 exists. PID 00 serves the
    // support mask of the snapshot, PID 02 the DTC that froze the frame.
    private respondMode02(command: string): string {
        const snapshot = this.freezeFrame;
        if (!snapshot || this.stored.length === 0) return NO_DATA;
        if (command.slice(4, 6) !== '00') return NO_DATA;
        const pid = Number.parseInt(command.slice(2, 4), 16);
        if (Number.isNaN(pid)) return NO_DATA;

        if (pid % MASK_BLOCK === 0 && pid <= LAST_MASK_BASE) {
            const ids = new Set([...snapshot.keys(), 0x02]);
            return `42${toHex(pid)}00${maskBytesFor(ids, pid)}`;
        }
        if (pid === 0x02) {
            const pair = encodeDtc(this.stored[0]);
            if (!pair) return NO_DATA;
            return `420200${toHex(pair[0])}${toHex(pair[1])}`;
        }
        const data = snapshot.get(pid);
        if (!data) return NO_DATA;
        return `42${toHex(pid)}00${data.map(toHex).join('')}`;
    }

    // Mode 06 — serves the profile's monitor test records: mask queries from
    // their MID set, one 9-byte record per (mid, tid) on request.
    private respondMode06(command: string): string {
        const mid = Number.parseInt(command.slice(2, 4), 16);
        if (Number.isNaN(mid)) return NO_DATA;
        if (mid % MASK_BLOCK === 0 && mid <= LAST_MASK_BASE) {
            return `46${toHex(mid)}${maskBytesFor(this.monitorMids, mid)}`;
        }
        const records = this.profile.monitorTests.filter((t) => t.mid === mid);
        if (records.length === 0) return NO_DATA;
        const body = records
            .map(
                (t) =>
                    `${toHex(t.mid)}${toHex(t.tid)}${toHex(t.uasId)}` +
                    `${toHex(Math.floor(t.value / 256))}${toHex(t.value % 256)}` +
                    `${toHex(Math.floor(t.min / 256))}${toHex(t.min % 256)}` +
                    `${toHex(Math.floor(t.max / 256))}${toHex(t.max % 256)}`,
            )
            .join('');
        return `46${body}`;
    }

    // Mode 09 — vehicle information; payloads longer than one CAN frame are
    // framed by the adapter layer (ISO-TP long form or raw frames).
    private respondMode09(command: string): string {
        const hex = (bytes: number[]) => bytes.map(toHex).join('');
        switch (command.slice(2)) {
            case '02':
                return hex([0x49, 0x02, 0x01, ...asciiBytes(this.profile.vin)]);
            case '04':
                return hex([0x49, 0x04, 0x01, ...asciiBytes(this.profile.calibrationId.padEnd(16, '\0'))]);
            case '06':
                return hex([0x49, 0x06, 0x01, ...hexToBytes(this.profile.cvn)]);
            case '08':
            case '0B': {
                const wanted = this.profile.ignition === 'spark' ? '08' : '0B';
                if (command.slice(2) !== wanted) return NO_DATA;
                const counters = this.profile.performanceCounters;
                const bytes = counters.flatMap((value) => [Math.floor(value / 256) & 0xff, value & 0xff]);
                return hex([0x49, Number.parseInt(wanted, 16), counters.length, ...bytes]);
            }
            case '0A':
                return hex([0x49, 0x0a, 0x01, ...asciiBytes(this.profile.ecuName.padEnd(20, '\0'))]);
            default:
                return NO_DATA;
        }
    }

    private respondDtcRead(responseHeader: number, codes: readonly string[]): string {
        const pairs = codes.map(encodeDtc).filter((pair): pair is [number, number] => pair !== null);
        const body = pairs.map(([a, b]) => `${toHex(a)}${toHex(b)}`).join('');
        // CAN framing: count byte then the code pairs.
        return `${toHex(responseHeader)}${toHex(pairs.length)}${body}`;
    }

    // Mode 04 clears stored + pending codes and the freeze frame; permanent
    // codes survive (only the vehicle erases them after a verified repair).
    private respondDtcClear(): string {
        this.stored = [];
        this.pending = [];
        this.freezeFrame = null;
        return '44';
    }

    private captureFreezeFrame(): void {
        if (this.freezeFrame) return;
        const snapshot = new Map<number, number[]>();
        for (const pid of this.profile.pids) {
            const data = this.encodeCurrentValue(pid);
            if (data) snapshot.set(pid, data);
        }
        this.freezeFrame = snapshot;
    }

    private voltage(): string {
        const rpm = this.modelValue(0x0c) ?? 0;
        const base = rpm > 400 ? 14.1 : 12.4;
        return `${(base + this.jitter(0.15)).toFixed(1)}V`;
    }

    private encodeCurrentValue(pid: number): number[] | null {
        if (!this.supportedPids.has(pid)) return null;
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
