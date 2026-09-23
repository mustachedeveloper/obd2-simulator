import {readFileSync} from 'node:fs';
import {describe, expect, expectTypeOf, it} from 'vitest';
import * as core from '../src/index';
import * as node from '../src/node/index';
import type {
    AdapterPersona,
    CommandResult,
    DriveCycle,
    EcuProfile,
    EngineSnapshot,
    SignalFit,
    SimulatorDefinition,
    SimulatorId,
    SimulatorProvenance,
    VehicleProfile,
    VehicleTraits,
} from '../src/index';

// The 1.0 contract: every exported runtime name. Adding is fine (extend the
// list); removing or renaming one is a breaking change and must bump the
// major version — this test is the reminder.

describe('public API surface', () => {
    it('core entry (obd2-simulator)', () => {
        expect(Object.keys(core).sort()).toEqual([
            'ADAPTER_FAULTS',
            'ADAPTER_PRESETS',
            'ADAPTIVE_TIMING_FACTORS',
            'CLONE_OBDII_ADAPTER',
            'CLONE_V21_ADAPTER',
            'DEFAULT_ADAPTER',
            'DEFAULT_DIESEL_SIMULATOR',
            'DEFAULT_GASOLINE_SIMULATOR',
            'DEFAULT_SIMULATOR_ID',
            'DIESEL_PROFILE',
            'DefaultDrivingModel',
            'ELM_DEFAULT_TIMEOUT_HEX',
            'GASOLINE_PROFILE',
            'GENUINE_ELM_ADAPTER',
            'HYBRID_PROFILE',
            'MemoryLink',
            'PID_ENCODERS',
            'REFERENCE_PROFILE',
            'REFERENCE_SECOND_ECU_PIDS',
            'SIMULATORS',
            'STN_ADAPTER',
            'SimulatorEngine',
            'VLINKER_ADAPTER',
            'VLINKER_FD_ADAPTER',
            'createSimulator',
            'dieselDrivingModel',
            'encodeDtc',
            'gasolineDrivingModel',
            'getSimulator',
            'hybridDrivingModel',
            'latencyFromWireLog',
            'listSimulators',
            'normalizeDtc',
            'personaFromWireLog',
        ]);
    });

    it('node entry (obd2-simulator/node)', () => {
        expect(Object.keys(node).sort()).toEqual([
            'CONTROL_HELP',
            'applyControlCommand',
            'createControlServer',
            'createTcpServer',
        ]);
    });

    it('engine public members (from the class source — TS `private` is erased at runtime)', () => {
        const source = readFileSync(new URL('../src/core/SimulatorEngine.ts', import.meta.url), 'utf8');
        // Methods, accessors and arrow-function properties at class-member indent; TS `private` is erased at runtime.
        const members = [
            ...source.matchAll(
                /^ {4}(?!private )(?:public |override |readonly |static )*(?:get |set |async )?([a-zA-Z]\w*)\s*(?:\(|=\s*(?:async\s*)?\()/gm,
            ),
        ]
            .map((match) => match[1] ?? '')
            .filter((name) => !['constructor', 'if', 'for', 'while', 'switch', 'catch'].includes(name))
            .sort();
        expect(members).toEqual([
            'adapter',
            'clearDtcs',
            'clearFaults',
            'clearOverride',
            'clearOverrides',
            'execute',
            'failNext',
            'handleCommand',
            'ignition',
            'injectDtc',
            'interrupt',
            'linkState',
            'onCommand',
            'override',
            'overrides',
            'pendingDtcs',
            'pendingFaults',
            'permanentDtcs',
            'removeDtc',
            'resetAdapter',
            'restore',
            'setAdapter',
            'setIgnition',
            'snapshot',
            'storedDtcs',
            'wireFor',
        ]);
    });

    it('data shapes (type-level: `npm run typecheck` fails when a field is renamed or dropped)', () => {
        expectTypeOf<keyof VehicleProfile>().toEqualTypeOf<
            | 'name'
            | 'vin'
            | 'calibrationId'
            | 'cvn'
            | 'ecuName'
            | 'ignition'
            | 'pids'
            | 'readinessSinceClear'
            | 'readinessThisDriveCycle'
            | 'performanceCounters'
            | 'monitorTests'
            | 'storedDtcs'
            | 'pendingDtcs'
            | 'permanentDtcs'
            | 'protocol'
            | 'additionalEcus'
            | 'supportsPermanentDtcs'
            | 'framePadding'
            | 'clearRequiresEngineOff'
            | 'transmissionPid'
            | 'sourceAddress'
        >();
        expectTypeOf<keyof AdapterPersona>().toEqualTypeOf<
            | 'name'
            | 'banner'
            | 'description'
            | 'identifier'
            | 'stn'
            | 'honorsResponseHint'
            | 'hintCountsFrames'
            | 'batch'
            | 'adaptiveTiming'
            | 'adaptiveTimingFactor'
            | 'ignitionMonitor'
            | 'baseLatencyMs'
            | 'latencyJitterMs'
            | 'defaultTimeoutHex'
            | 'defaultSpaces'
            | 'protocolSearchMs'
            | 'bannerPrefix'
            | 'bannerBlankLine'
            | 'trimsFramePadding'
            | 'trimsRawSingleFrames'
            | 'padsSingleFrames'
            | 'canStatus'
            | 'protocolSearchFailMs'
            | 'atLatencyMs'
            | 'resetLatencyMs'
            | 'voltageOffsetV'
        >();
        expectTypeOf<keyof EcuProfile>().toEqualTypeOf<
            'id' | 'sourceAddress' | 'name' | 'pids' | 'readiness' | 'calibrationId' | 'cvn' | 'dtcReply' | 'clearReply'
        >();
        expectTypeOf<keyof CommandResult>().toEqualTypeOf<'command' | 'response' | 'wire' | 'latency' | 'silent'>();
        expectTypeOf<keyof EngineSnapshot>().toEqualTypeOf<
            'link' | 'storedDtcs' | 'pendingDtcs' | 'permanentDtcs' | 'freezeFrame' | 'overrides' | 'ignition' | 'pendingFaults'
        >();
        expectTypeOf<keyof SimulatorDefinition>().toEqualTypeOf<
            'id' | 'label' | 'description' | 'kind' | 'profile' | 'createModel' | 'provenance'
        >();
        expectTypeOf<keyof SimulatorProvenance>().toEqualTypeOf<'sessions' | 'from' | 'to' | 'importerVersion'>();
        expectTypeOf<keyof DriveCycle>().toEqualTypeOf<
            'stepSeconds' | 'speedKmh' | 'rpm' | 'throttlePct' | 'engineLoadPct' | 'fuelRateLph'
        >();
        expectTypeOf<keyof VehicleTraits>().toEqualTypeOf<
            | 'idleRpm'
            | 'coolantStartC'
            | 'coolantTargetC'
            | 'coolantWarmupTauS'
            | 'oilOverCoolantC'
            | 'chargingVoltage'
            | 'longTermFuelTrimPct'
            | 'intakeTempC'
            | 'ambientC'
            | 'odometerKm'
            | 'fuelLevelPct'
            | 'warmupsSinceClear'
            | 'distanceSinceClearKm'
        >();
        expectTypeOf<keyof SignalFit>().toEqualTypeOf<'base' | 'perLoadPct' | 'perKrpm' | 'perKmh' | 'min' | 'max' | 'noise'>();
        // Ids only ever get added.
        expectTypeOf<'default-gasoline' | 'default-diesel'>().toMatchTypeOf<SimulatorId>();
    });
});
