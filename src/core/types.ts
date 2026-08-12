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
