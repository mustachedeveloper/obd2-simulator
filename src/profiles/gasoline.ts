import type {VehicleProfile} from '../core/types';

// A typical spark-ignition passenger car: VW-coded VIN (model year 2011),
// catalyst/EVAP/O2/O2-heater/EGR monitors with EVAP still incomplete.
export const GASOLINE_PROFILE: VehicleProfile = {
    name: 'gasoline',
    vin: 'WVWZZZ1KZBW123456',
    calibrationId: 'OBD2SIM-CAL-0001',
    cvn: 'A1B2C3D4',
    ecuName: 'ECM-EngineControl',
    ignition: 'spark',
    pids: [
        0x04, 0x05, 0x06, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x14, 0x2f, 0x33, 0x42, 0x46, 0x51, 0x5c, 0x62,
    ],
    readinessSinceClear: [0x07, 0xe5, 0x04],
    readinessThisDriveCycle: [0x17, 0xe5, 0x24],
    // OBDCOND, IGNCNTR, CATCOMP1, CATCOND1.
    performanceCounters: [120, 300, 40, 110],
    monitorTests: [
        // Catalyst bank 1: ratio ×0.001 (UAS 0x02), 0.200 within [0, 0.400].
        {mid: 0x21, tid: 0x86, uasId: 0x02, value: 200, min: 0, max: 400},
        // Misfire cylinder 1: count (UAS 0x01), 10 against a max of 5 → fail.
        {mid: 0xa2, tid: 0x0b, uasId: 0x01, value: 10, min: 0, max: 5},
    ],
};
