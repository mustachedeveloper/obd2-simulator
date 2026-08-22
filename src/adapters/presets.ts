import type {AdapterPersona} from '../core/types';

// Adapter personas measured from real devices on the same vehicle (2-ECU
// Škoda, ISO 15765-4 CAN 29/500 — see src/profiles/reference.ts and
// tests/fixtures/wirelog). Latencies are p50 wire-log values with the
// response hint honored (vLinker) or the ATST19 = 100 ms window waited
// (clone). The vehicle decides how many ECUs answer; the persona decides
// whether you get to see them (hint handling) and how they are printed.

// Second ECU of the reference vehicle answers exactly these mode 01 PIDs.
export const REFERENCE_SECOND_ECU_PIDS: readonly number[] = [
    0x00, 0x01, 0x04, 0x05, 0x0c, 0x0d, 0x0f, 0x20, 0x33, 0x40, 0x41, 0x42, 0x46, 0x49,
];

const ELM_DESCRIPTION = 'OBDII to RS232 Interpreter';

// The ideal ELM: hint honored, no jitter, no spaces, no protocol search —
// app-friendly output for unit tests.
export const DEFAULT_ADAPTER: AdapterPersona = {
    name: 'default',
    banner: 'ELM327 v1.5',
    description: ELM_DESCRIPTION,
    identifier: null,
    stn: null,
    honorsResponseHint: true,
    batch: {supported: true, maxPids: 6, multiFrameClean: true},
    adaptiveTiming: true,
    ignitionMonitor: true,
    baseLatencyMs: 40,
    latencyJitterMs: 0,
    defaultSpaces: false,
    protocolSearchMs: null,
};

// Vgate vLinker (BLE name IOS-Vlink): honors the hint, so with '010C 1'
// only the engine ECU is visible; without a hint every ECU prints. Its
// auto-protocol search on the reference car took ~6 s.
export const VLINKER_ADAPTER: AdapterPersona = {
    name: 'vlinker',
    banner: 'ELM327 v2.3',
    description: ELM_DESCRIPTION,
    identifier: null,
    stn: null,
    honorsResponseHint: true,
    batch: {supported: true, maxPids: 6, multiFrameClean: true},
    adaptiveTiming: true,
    ignitionMonitor: true,
    baseLatencyMs: 32,
    latencyJitterMs: 6,
    defaultSpaces: true,
    protocolSearchMs: 6000,
};

// Cheap v2.1 clone (BLE name OBDBLE): ignores the hint and waits the whole
// ATST window, prints every ECU, glues 'OK' in front of its banner. Ships
// with a near-maximum default timeout, so ATST matters. Its multi-frame
// output is sequential per ECU in every recording (mode 09 on two ECUs);
// set batch.multiFrameClean: false to simulate a clone that interleaves.
export const CLONE_V21_ADAPTER: AdapterPersona = {
    name: 'clone-v2.1',
    banner: 'ELM327 v2.1',
    description: ELM_DESCRIPTION,
    identifier: null,
    stn: null,
    honorsResponseHint: false,
    batch: {supported: true, maxPids: 6, multiFrameClean: true},
    adaptiveTiming: false,
    ignitionMonitor: false,
    baseLatencyMs: 20,
    latencyJitterMs: 15,
    defaultTimeoutHex: 'FF',
    defaultSpaces: true,
    protocolSearchMs: 150,
    bannerPrefix: 'OK',
    bannerBlankLine: false,
};

// Genuine ELM Electronics part (reference behaviour).
export const GENUINE_ELM_ADAPTER: AdapterPersona = {
    name: 'genuine-elm',
    banner: 'ELM327 v2.2',
    description: ELM_DESCRIPTION,
    identifier: null,
    stn: null,
    honorsResponseHint: true,
    batch: {supported: true, maxPids: 6, multiFrameClean: true},
    adaptiveTiming: true,
    ignitionMonitor: true,
    baseLatencyMs: 30,
    latencyJitterMs: 4,
    defaultSpaces: true,
    protocolSearchMs: 1000,
};

// OBDLink (STN chipset): ELM-compatible banner plus the ST identity set.
export const STN_ADAPTER: AdapterPersona = {
    name: 'stn',
    banner: 'ELM327 v1.4b',
    description: ELM_DESCRIPTION,
    identifier: null,
    stn: {deviceId: 'OBDLink MX+ r5.0', firmware: 'STN2255 v5.6.19'},
    honorsResponseHint: true,
    batch: {supported: true, maxPids: 6, multiFrameClean: true},
    adaptiveTiming: true,
    ignitionMonitor: true,
    baseLatencyMs: 25,
    latencyJitterMs: 3,
    defaultSpaces: true,
    protocolSearchMs: 500,
};

export const ADAPTER_PRESETS: Readonly<Record<string, AdapterPersona>> = {
    default: DEFAULT_ADAPTER,
    vlinker: VLINKER_ADAPTER,
    clone: CLONE_V21_ADAPTER,
    genuine: GENUINE_ELM_ADAPTER,
    stn: STN_ADAPTER,
};
