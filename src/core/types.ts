// Public domain types of the simulator core.

export type DtcStatus = 'stored' | 'pending' | 'permanent';

export type IgnitionType = 'spark' | 'compression';

// One mode 06 on-board monitor test record (CAN format).
export interface MonitorTestRecord {
    mid: number;
    tid: number;
    uasId: number;
    value: number;
    min: number;
    max: number;
}

// Readiness bytes B/C/D of PID 0x01 / 0x41 (SAE J1979). Byte B carries the
// continuous monitors + ignition-type flag, C the supported non-continuous
// monitors, D their incompleteness bits.
export type ReadinessBytes = readonly [number, number, number];

// Everything that makes the fake vehicle THIS vehicle. Pure data — profiles
// are JSON-compatible and shippable.
export interface VehicleProfile {
    name: string;
    vin: string;
    calibrationId: string;
    // 8 hex chars (4-byte calibration verification number).
    cvn: string;
    ecuName: string;
    ignition: IgnitionType;
    // Mode 01 signal PIDs the vehicle advertises via the support masks.
    // Status PIDs 0x01/0x41 are always present and served separately.
    pids: readonly number[];
    readinessSinceClear: ReadinessBytes;
    readinessThisDriveCycle: ReadinessBytes;
    // In-use performance tracking counters (mode 09 infotype 08/0B), in
    // standardized wire order.
    performanceCounters: readonly number[];
    monitorTests: readonly MonitorTestRecord[];
    // Codes present at power-on.
    storedDtcs?: readonly string[];
    pendingDtcs?: readonly string[];
    permanentDtcs?: readonly string[];
}

// Injectable logging surface; defaults to silence.
export interface SimulatorLogger {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
}

// A driving model produces the physical value of a mode 01 PID at a moment
// in time. Return null for "this PID has no data right now" (NO DATA).
export interface DrivingModel {
    value(pid: number, elapsedSeconds: number, jitter: (amplitude: number) => number): number | null;
}

export type LinkStatus = 'disconnected' | 'connecting' | 'connected';

// ---------------------------------------------------------------------------
// Adapter persona — what makes the fake ELM327 THIS adapter (identity,
// quirks, timing). Pure data like VehicleProfile; presets live in
// src/adapters/presets.ts and were derived from wire logs of real devices.

export interface AdapterBatchCapability {
    // false → any multi-PID request answers NO DATA.
    supported: boolean;
    // Requests with more PIDs than this answer NO DATA.
    maxPids: number;
    // false + 2 ECUs → multi-frame segments of the two ECUs interleave
    // (the "dirty" output seen on clones). Irrelevant with one ECU.
    multiFrameClean: boolean;
}

export interface AdapterStnIdentity {
    // STDI ("OBDLink MX+ r5.0")
    deviceId: string;
    // STI ("STN2255 v5.6.19")
    firmware: string;
}

export interface AdapterPersona {
    name: string;
    // ATZ / ATWS / ATI
    banner: string;
    // AT@1
    description: string;
    // AT@2; null → '?'
    identifier: string | null;
    // STI / STDI; null → '?'
    stn: AdapterStnIdentity | null;
    // '010C 2' → return as soon as 2 responses arrived. false → always wait
    // the full ATST window and print every response.
    honorsResponseHint: boolean;
    // CAN response ids; the first is the engine ECU serving the whole
    // profile, the rest serve only secondEcuPids.
    respondingEcus: readonly string[];
    secondEcuPids?: readonly number[];
    batch: AdapterBatchCapability;
    // false → ATAT0/1/2 answer OK but do not change the wait window.
    adaptiveTiming: boolean;
    // false → ATIGN answers '?'.
    ignitionMonitor: boolean;
    // Fixed part of every response latency; the wait window is added on top.
    baseLatencyMs: number;
    // Symmetric ± jitter drawn from the engine's seeded PRNG (0 → none).
    latencyJitterMs: number;
    // ATST value after reset (hex); ELM327 default is '32' (200 ms).
    defaultTimeoutHex?: string;
}

export type AdaptiveTimingMode = 0 | 1 | 2;

// Mutable adapter settings touched by AT commands (reset by ATZ/ATWS/ATD).
export interface LinkState {
    echo: boolean;
    headers: boolean;
    // ATST hh — wait window = hh × 4 ms.
    timeoutHex: string;
    adaptiveTiming: AdaptiveTimingMode;
    // ATCRA hhh — only that ECU's responses are printed; null → all.
    receiveFilter: string | null;
    // ATSH hhh — 7DF functional (all ECUs) or 7E0..7E7 physical.
    requestHeader: string;
    // ATSP x — '0' is auto.
    protocol: string;
}

export interface CommandLatency {
    baseMs: number;
    jitterMs: number;
    // ATST window the adapter sat through before printing.
    waitMs: number;
    totalMs: number;
}

export interface CommandResult {
    // Normalized command (whitespace stripped, upper-cased).
    command: string;
    // Payload without the trailing '>' prompt, echo included when enabled.
    response: string;
    latency: CommandLatency;
}
