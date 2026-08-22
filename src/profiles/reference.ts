import type {VehicleProfile} from '../core/types';
import {REFERENCE_SECOND_ECU_PIDS} from '../adapters/presets';
import {GASOLINE_PROFILE} from './gasoline';

// The vehicle the adapter presets were measured on: a 2011 spark-ignition
// Škoda on ISO 15765-4 CAN 29/500 with an engine ECU, a transmission ECU
// and a third module that rejects DTC requests (7F xx 10). Its mode 01
// support masks were read from the wire logs in tests/fixtures/wirelog;
// PIDs the simulator has no encoder for are left out.

const ENGINE_PIDS: readonly number[] = [
    0x03, 0x04, 0x05, 0x06, 0x07, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x11, 0x13, 0x15, 0x1c, 0x1f, 0x21, 0x2e, 0x2f,
    0x30, 0x31, 0x33, 0x3c, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x49, 0x4a, 0x4c, 0x51, 0x53, 0x55, 0x56, 0x5c,
    0x5e, 0x62, 0x63, 0x67, 0x68, 0x73, 0x78, 0x7a, 0x8e, 0xa4, 0xa6,
];

export const REFERENCE_PROFILE: VehicleProfile = {
    ...GASOLINE_PROFILE,
    name: 'reference',
    protocol: '7',
    pids: ENGINE_PIDS,
    calibrationId: '05E019EB4180BEAJ',
    cvn: 'AD343D35',
    ecuName: 'ECM-EngineControl',
    // OBDCOND, IGNCNTR and the monitor completion/condition counter pairs
    // in J1979 wire order (12 words, as the reference car reports).
    performanceCounters: [795, 3220, 909, 795, 0, 0, 898, 795, 0, 0, 1591, 795],
    supportsPermanentDtcs: false,
    additionalEcus: [
        // Answers DTC requests with a negative response, nothing else.
        {id: '7EA', pids: [], dtcReply: 'reject'},
        {
            id: '7E9',
            name: 'TCM-TransmisCtrl',
            pids: REFERENCE_SECOND_ECU_PIDS.filter((pid) => pid % 0x20 !== 0),
            readiness: [0x04, 0x00, 0x00],
            calibrationId: '0CW90655E6C+0562',
            cvn: 'A9C9EF55',
        },
    ],
};
