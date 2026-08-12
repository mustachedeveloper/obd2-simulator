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
    pids: [
        0x04, 0x05, 0x06, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x2f, 0x33, 0x42, 0x46, 0x51, 0x5c, 0x62,
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
