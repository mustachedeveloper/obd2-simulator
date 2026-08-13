import type {VehicleProfile} from '../core/types';
import {DefaultDrivingModel} from '../core/DefaultDrivingModel';

// A compression-ignition (diesel) car: NMHC/NOx/PM-filter monitor set with
// the PM filter still incomplete, diesel fuel type, permanent DPF code.
export const DIESEL_PROFILE: VehicleProfile = {
    name: 'diesel',
    vin: 'WVWZZZ7NZKV654321',
    calibrationId: 'OBD2SIM-CAL-0002',
    cvn: 'D4C3B2A1',
    ecuName: 'ECM-DieselControl',
    ignition: 'compression',
    // Compression-ignition set: no O2/lambda/EVAP, EGR via the 0x69 packet,
    // plus the diesel pack — turbo, EGT, DPF, NOx, AdBlue/DEF.
    pids: [
        0x03, 0x04, 0x05, 0x0b, 0x0c, 0x0d, 0x0f, 0x10, 0x11, 0x1c, 0x1f, 0x21, 0x23, 0x2f, 0x30, 0x31, 0x33, 0x42,
        0x43, 0x45, 0x47, 0x49, 0x4a, 0x4c, 0x4d, 0x4e, 0x51, 0x59, 0x5c, 0x5d, 0x5e, 0x61, 0x62, 0x63, 0x64, 0x66,
        0x67, 0x68, 0x69, 0x6f, 0x73, 0x74, 0x78, 0x79, 0x7a, 0x7c, 0x83, 0x8e, 0x9b, 0xa4, 0xa6,
    ],
    // B bit 3 set → compression ignition.
    readinessSinceClear: [0x0f, 0x63, 0x40],
    readinessThisDriveCycle: [0x1f, 0x63, 0x41],
    // OBDCOND, IGNCNTR, HCCATCOMP, HCCATCOND.
    performanceCounters: [200, 480, 55, 180],
    monitorTests: [
        // NMHC catalyst: ratio, passing.
        {mid: 0x21, tid: 0x86, uasId: 0x02, value: 150, min: 0, max: 400},
    ],
};

// Driving model matching the profile (PID 0x51 reports diesel).
export const dieselDrivingModel = () => new DefaultDrivingModel({fuelType: 4});
