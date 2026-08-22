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
     * maps to source address 0x10 + 8·n (7E9 → 18DAF118), not configurable.
     */
    id: string;
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
    value(pid: number, elapsedSeconds: number, jitter: (amplitude: number) => number): number | null;
}

export type LinkStatus = 'disconnected' | 'connecting' | 'connected';

/**
 * Vehicle power state: key off (every ECU asleep), key on with the engine
 * stopped, or running (the driving cycle).
 */
export type IgnitionState = 'off' | 'key-on' | 'running';

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
    batch: AdapterBatchCapability;
    /**
     * false → ATAT0/1/2 answer OK but do not change the wait window.
     */
    adaptiveTiming: boolean;
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
}
