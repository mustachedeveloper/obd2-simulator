// Public domain types of the simulator core.

export type DtcStatus = 'stored' | 'pending' | 'permanent';

export type IgnitionType = 'spark' | 'compression';

/**
 * One mode 06 on-board monitor test record (CAN format).
 */
export interface MonitorTestRecord {
    mid: number;
    tid: number;
    uasId: number;
    value: number;
    min: number;
    max: number;
}

/**
 * Readiness bytes B/C/D of PID 0x01 / 0x41 (SAE J1979). Byte B carries the
 * continuous monitors + ignition-type flag, C the supported non-continuous
 * monitors, D their incompleteness bits.
 */
export type ReadinessBytes = readonly [number, number, number];

/**
 * ISO 15765-4 variants (ELM327 protocol numbers): 11/29-bit ids at 500/250 kbit.
 */
export type CanProtocol = '6' | '7' | '8' | '9';

/**
 * What an additional ECU (transmission, ABS, ...) answers on the bus. The
 * engine ECU is the profile itself; these are the others that show up as
 * extra response lines on functional requests.
 */
export interface EcuProfile {
    /**
     * 11-bit CAN response id, 7E9..7EF ('7E9'); on 29-bit vehicles the id
     * maps to source address 0x10 + 8·n (7E9 → 18DAF118) unless
     * `sourceAddress` says otherwise.
     */
    id: string;
    /**
     * The ECU's address on a 29-bit bus: it answers as 18DAF1xx and is
     * addressed physically as 18DAxxF1. One byte, unique per vehicle.
     */
    sourceAddress?: number;
    /**
     * Mode 09 infotype 0A. Absent → the ECU does not answer 090A.
     */
    name?: string;
    /**
     * Mode 01 PIDs this ECU serves (a subset of the vehicle's signal set).
     */
    pids: readonly number[];
    /**
     * Readiness bytes B/C/D reported on PIDs 01/41; default all zero.
     */
    readiness?: ReadinessBytes;
    /**
     * Mode 09 infotypes 04 / 06. Absent → the ECU does not answer them.
     */
    calibrationId?: string;
    cvn?: string;
    /**
     * Modes 03/07/0A (and freeze frame 02 02): 'empty' → an empty code list,
     * 'reject' → negative response 7F xx 10, 'none' → stays silent. Default
     * 'empty'.
     */
    dtcReply?: 'empty' | 'reject' | 'none';
    /**
     * Mode 04: 'positive' → 44, 'pending' → 7F 04 78 (response pending, and
     * nothing after it — what two modules of the recorded car send),
     * 'reject' → 7F 04 10, 'none' → silent. Default: follows `dtcReply`
     * (positive / reject / none). A module can answer mode 04 alone:
     * `{pids: [], dtcReply: 'none', clearReply: 'pending'}`.
     */
    clearReply?: 'positive' | 'pending' | 'reject' | 'none';
}

/**
 * Everything that makes the fake vehicle THIS vehicle. Pure data — profiles
 * are JSON-compatible and shippable.
 */
export interface VehicleProfile {
    name: string;
    vin: string;
    calibrationId: string;
    /**
     * 8 hex chars (4-byte calibration verification number).
     */
    cvn: string;
    ecuName: string;
    ignition: IgnitionType;
    /**
     * Mode 01 signal PIDs the vehicle advertises via the support masks.
     * Status PIDs 0x01/0x41 are always present and served separately.
     */
    pids: readonly number[];
    readinessSinceClear: ReadinessBytes;
    readinessThisDriveCycle: ReadinessBytes;
    /**
     * In-use performance tracking counters (mode 09 infotype 08/0B), in
     * standardized wire order.
     */
    performanceCounters: readonly number[];
    monitorTests: readonly MonitorTestRecord[];
    /**
     * Codes present at power-on.
     */
    storedDtcs?: readonly string[];
    pendingDtcs?: readonly string[];
    permanentDtcs?: readonly string[];
    /**
     * Bus protocol the adapter detects in auto mode; default '6' (CAN 11/500).
     */
    protocol?: CanProtocol;
    /**
     * ECUs besides the engine ECU (which always answers as 7E8).
     */
    additionalEcus?: readonly EcuProfile[];
    /**
     * false → mode 0A answers NO DATA (many pre-2010 vehicles). Default true.
     */
    supportsPermanentDtcs?: boolean;
    /**
     * Byte the ECUs fill unused CAN frame bytes with (commonly 0xAA). Shows
     * up as the tail of the last 'N:' segment of a multi-frame response and,
     * with headers on, in every frame. Absent → no padding (raw frames are
     * zero-filled).
     */
    framePadding?: number;
    /**
     * true → mode 04 is refused with 7F 04 22 (conditions not correct) while
     * the engine runs, as many real vehicles do; key-on, engine-off clears.
     * Default false.
     */
    clearRequiresEngineOff?: boolean;
    /**
     * What PID 0xA4 carries. 'ratio' (default): the gear ratio in bytes C–D,
     * no data at standstill. 'gear': the engaged gear alone — support byte
     * 01, gear in the upper nibble of byte B (0 at standstill), estimated
     * from engine speed per road speed; an override of 0xA4 is the gear.
     */
    transmissionPid?: 'ratio' | 'gear';
    /**
     * How long the engine ECU stays awake after the engine stops, rejecting
     * every request with 7F xx 22 while the other modules are already
     * silent — what `setIgnition('off')` uses when given no `afterRunMs`.
     * Every recording of the recorded car shows the phase (66 engine
     * stops, never a straight NO DATA); how long it lasts depends on when
     * the car goes to sleep: the importer stores the longest phase seen to
     * end (145 s), one recording was still rejecting after 17 minutes.
     * Default 0.
     */
    afterRunMs?: number;
    /**
     * The engine ECU's address on a 29-bit bus (see
     * `EcuProfile.sourceAddress`); default 0x10.
     */
    sourceAddress?: number;
}

/**
 * Injectable logging surface; defaults to silence.
 */
export interface SimulatorLogger {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
}

/**
 * A driving model produces the physical value of a mode 01 PID at a moment
 * in time. Return null for "this PID has no data right now" (NO DATA).
 */
export interface DrivingModel {
    /**
     * Physical value of a mode 01 PID `elapsedSeconds` after power-on; null
     * → NO DATA. `context.engineStopped` is set while the key is on with the
     * engine stopped: the moving parts rest, `elapsedSeconds` is the moment
     * the engine stopped (so slow sensors — temperatures — hold). A model
     * may ignore it.
     */
    value(
        pid: number,
        elapsedSeconds: number,
        jitter: (amplitude: number) => number,
        context?: {engineStopped?: boolean},
    ): number | null;
}

export type LinkStatus = 'disconnected' | 'connecting' | 'connected';

/**
 * Vehicle power state: key off (every ECU asleep), key on with the engine
 * stopped, or running (the driving cycle).
 */
export type IgnitionState = 'off' | 'key-on' | 'running';

export interface SetIgnitionOptions {
    /**
     * How long the engine ECU rejects every request with 7F xx 22
     * (conditions not correct) after the engine stopped, while the other
     * ECUs are silent. With 'off' it then falls asleep (NO DATA); default:
     * the vehicle's `VehicleProfile.afterRunMs` (0 — asleep at once — for a
     * profile without one). With 'key-on' it then answers with the engine
     * stopped; default: 3 s when the engine was running (recorded: 1–4 s),
     * none when the key was off. Not allowed with 'running'. Not part of a
     * snapshot: restore() lands after the phase.
     */
    afterRunMs?: number;
}

/**
 * Error texts an ELM327 prints instead of a response; injectable per request.
 */
export type AdapterFault = 'BUFFER FULL' | 'CAN ERROR' | 'BUS ERROR' | 'DATA ERROR' | 'STOPPED' | 'UNABLE TO CONNECT' | 'NO DATA';

export const ADAPTER_FAULTS: readonly AdapterFault[] = [
    'BUFFER FULL',
    'CAN ERROR',
    'BUS ERROR',
    'DATA ERROR',
    'STOPPED',
    'UNABLE TO CONNECT',
    'NO DATA',
];

/**
 * Everything mutable about an engine, JSON-compatible (snapshot / restore).
 */
export interface EngineSnapshot {
    link: LinkState;
    storedDtcs: readonly string[];
    pendingDtcs: readonly string[];
    permanentDtcs: readonly string[];
    /**
     * [pid, encoded data bytes]; null → no frame captured.
     */
    freezeFrame: readonly (readonly [number, readonly number[]])[] | null;
    /**
     * pid → physical value, null → NO DATA.
     */
    overrides: Readonly<Record<number, number | null>>;
    ignition: IgnitionState;
    pendingFaults: readonly AdapterFault[];
}

// ---------------------------------------------------------------------------
// Adapter persona — what makes the fake ELM327 THIS adapter (identity,
// quirks, timing). Pure data like VehicleProfile; presets live in
// src/adapters/presets.ts and were derived from wire logs of real devices.

export interface AdapterBatchCapability {
    /**
     * false → any multi-PID request answers NO DATA.
     */
    supported: boolean;
    /**
     * Requests with more PIDs than this answer NO DATA.
     */
    maxPids: number;
    /**
     * What a request beyond `maxPids` gets. 'no-data' (default) prints NO
     * DATA; 'silent' prints nothing at all — not even the prompt — until the
     * next command, the way one recorded clone drops every request with
     * three or more PIDs and leaves the app to its timeout.
     */
    overflow?: 'no-data' | 'silent';
    /**
     * false + 2 ECUs → multi-frame segments of the two ECUs interleave
     * (the "dirty" output seen on clones). Irrelevant with one ECU.
     */
    multiFrameClean: boolean;
}

export interface AdapterStnIdentity {
    /**
     * STDI ("OBDLink MX+ r5.0")
     */
    deviceId: string;
    /**
     * STI ("STN2255 v5.6.19")
     */
    firmware: string;
}

export interface AdapterPersona {
    name: string;
    /**
     * ATZ / ATWS / ATI
     */
    banner: string;
    /**
     * AT@1
     */
    description: string;
    /**
     * AT@2; null → '?'
     */
    identifier: string | null;
    /**
     * STI / STDI; null → '?'
     */
    stn: AdapterStnIdentity | null;
    /**
     * '010C 2' → return as soon as 2 responses arrived. false → always wait
     * the full ATST window and print every response.
     */
    honorsResponseHint: boolean;
    /**
     * true → the honored hint counts CAN frames, not responses: '017A 1'
     * prints the length line and the first frame of a multi-frame answer and
     * nothing else (seen on the vLinker). Default false.
     */
    hintCountsFrames?: boolean;
    batch: AdapterBatchCapability;
    /**
     * false → ATAT0/1/2 answer OK but do not change the wait window.
     */
    adaptiveTiming: boolean;
    /**
     * Share of the ATST window this adapter still waits under ATAT1 when
     * the response hint is absent or unmet (default
     * `ADAPTIVE_TIMING_FACTORS[1]`, the whole window). Measured per
     * hardware: the vLinkers return an unhinted two-ECU batch after ≈ 55 %
     * of the window.
     */
    adaptiveTimingFactor?: number;
    /**
     * false → ATIGN answers '?'.
     */
    ignitionMonitor: boolean;
    /**
     * Fixed part of every response latency; the wait window is added on top.
     */
    baseLatencyMs: number;
    /**
     * Symmetric ± jitter drawn from the engine's seeded PRNG (0 → none).
     */
    latencyJitterMs: number;
    /**
     * ATST value after reset (hex); ELM327 default is '32' (200 ms).
     */
    defaultTimeoutHex?: string;
    /**
     * Spaces between bytes after reset (ATS). Real hardware defaults to on;
     * the ideal default persona keeps them off for app-friendly output.
     */
    defaultSpaces: boolean;
    /**
     * Time a protocol search (first request after reset/ATSP0) costs, with
     * 'SEARCHING...' printed first. null → never searches.
     */
    protocolSearchMs: number | null;
    /**
     * Junk some clones print in front of the reset banner ('OK' → 'OKELM327 v2.1').
     */
    bannerPrefix?: string;
    /**
     * Blank line before the reset banner (genuine behaviour). Default true.
     */
    bannerBlankLine?: boolean;
    /**
     * true → the last 'N:' segment of a multi-frame response is cut to the
     * announced length, hiding the vehicle's frame padding (seen on v2.1
     * clones). Default false: the whole consecutive frame is printed, as
     * genuine chips and the vLinker do.
     */
    trimsFramePadding?: boolean;
    /**
     * true → with headers on, a single frame is printed only as far as its
     * PCI length says ('18DAF10104410C0E7E'), without the frame's padding;
     * multi-frame output keeps whole frames. Seen on the vLinkers. Default
     * false: all eight bytes.
     */
    trimsRawSingleFrames?: boolean;
    /**
     * true → single-frame answers are printed as the whole CAN frame, so
     * the vehicle's frame padding trails them with headers off
     * ('410C0E88AAAAAA'). Seen on a v2.1 clone; needs `framePadding` on the
     * vehicle. Default false.
     */
    padsSingleFrames?: boolean;
    /**
     * ATCS output. Default 'T:00 R:00 F:00'; the recorded adapters print
     * 'T:00 R:00 F:0', 'R:00' or just 'OK'.
     */
    canStatus?: string;
    /**
     * Time a search costs when no ECU answers (SEARCHING... → UNABLE TO
     * CONNECT); adapters try every protocol before giving up, so it is
     * usually longer. Default: `protocolSearchMs`.
     */
    protocolSearchFailMs?: number;
    /**
     * Fixed latency of AT commands when it differs from OBD requests (the
     * clones take 60–70 ms for an `OK`). Default: `baseLatencyMs`.
     */
    atLatencyMs?: number;
    /**
     * Fixed latency of ATZ / ATWS — a real reset takes about a second on
     * the vLinkers. Default: the AT latency.
     */
    resetLatencyMs?: number;
    /**
     * Added to every ATRV reading: cheap adapters measure the supply rail
     * with an uncalibrated divider (one clone reads 1.6 V high). Default 0.
     */
    voltageOffsetV?: number;
    /**
     * Latency of ATCS when it differs from other AT commands: the vLinkers
     * sample the bus for ≈ 430 ms before printing the counters. Default:
     * the AT latency.
     */
    canStatusLatencyMs?: number;
    /**
     * true → connecting resets the adapter like a power-up: after
     * `resetLatencyMs` the banner shows up on the wire unprompted, with
     * `bootNoise` in front of it on a link's first connection. Seen on the
     * vLinker over BLE: an app that sends ATZ right after connecting takes
     * that banner for the reply. Default false.
     */
    resetsOnConnect?: boolean;
    /**
     * true → bytes that arrive while a reset runs (ATZ, ATWS or the connect
     * reset) are discarded: never executed, never answered. Seen on the
     * vLinker: an ATE0 sent during a real ATZ is lost and the echo stays
     * on. Honoured by interruptible links, which know what is in flight;
     * queued transports answer every command. Default false.
     */
    dropsInputDuringReset?: boolean;
    /**
     * Junk the adapter's UART emits in front of its power-up banner ('ÿ\0'
     * on the vLinker), printed once per link, on the first connection.
     * Default none.
     */
    bootNoise?: string;
}

export type AdaptiveTimingMode = 0 | 1 | 2;

/**
 * Mutable adapter settings touched by AT commands (reset by ATZ/ATWS/ATD).
 */
export interface LinkState {
    echo: boolean;
    headers: boolean;
    /**
     * ATS — spaces between printed bytes.
     */
    spaces: boolean;
    /**
     * ATL — '\r\n' instead of '\r' line endings.
     */
    linefeeds: boolean;
    /**
     * Protocol search already done (auto mode); cleared by reset/ATSP/ATPC.
     */
    searched: boolean;
    /**
     * ATST hh — wait window = hh × 4 ms.
     */
    timeoutHex: string;
    adaptiveTiming: AdaptiveTimingMode;
    /**
     * OBD requests that sat through the wait window since the last reset or
     * protocol change: what adaptive timing (AT1) has learned from. The
     * first waits the whole window, later ones converge on the persona's
     * `adaptiveTimingFactor`.
     */
    adaptiveSamples: number;
    /**
     * ATCRA hhh — only that ECU's responses are printed; null → all.
     */
    receiveFilter: string | null;
    /**
     * ATSH hhh — 7DF functional (all ECUs) or 7E0..7E7 physical.
     */
    requestHeader: string;
    /**
     * ATSP x — '0' is auto.
     */
    protocol: string;
}

export interface CommandLatency {
    baseMs: number;
    jitterMs: number;
    /**
     * ATST window the adapter sat through before printing.
     */
    waitMs: number;
    /**
     * Protocol search on the first request in auto mode.
     */
    searchMs: number;
    totalMs: number;
}

export interface CommandResult {
    /**
     * Normalized command (whitespace stripped, upper-cased).
     */
    command: string;
    /**
     * Lines joined with the adapter's line ending, echo included when
     * enabled, without the blank line + '>' prompt.
     */
    response: string;
    /**
     * Exactly the bytes the adapter prints: response, blank line, prompt.
     */
    wire: string;
    latency: CommandLatency;
    /**
     * true → the adapter prints nothing for this command, not even the
     * prompt (`wire` is empty); transports stay quiet and the app runs into
     * its timeout. See `AdapterBatchCapability.overflow`.
     */
    silent: boolean;
}
