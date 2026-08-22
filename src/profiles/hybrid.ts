import {DefaultDrivingModel} from '../core/DefaultDrivingModel';
import {clamp} from '../core/j1979';
import type {DrivingModel, VehicleProfile} from '../core/types';
import {GASOLINE_PROFILE} from './gasoline';

// A gasoline hybrid (Toyota-coded VIN): the spark-ignition PID set plus the
// hybrid battery pack (PID 0x5B), fuel type "hybrid gasoline", and a driving
// model that shuts the combustion engine off at standstill (EV mode).

const FUEL_TYPE_HYBRID_GASOLINE = 0x11;
const PACK_START_PCT = 72;
const PACK_DRAIN_PCT_PER_HOUR = 3;
const PID_HYBRID_PACK = 0x5b;

export const HYBRID_PROFILE: VehicleProfile = {
    ...GASOLINE_PROFILE,
    name: 'hybrid',
    vin: 'JTDKB20U903456789',
    calibrationId: 'OBD2SIM-CAL-0003',
    cvn: '7B1D2E3F',
    ecuName: 'ECM-HybridControl',
    pids: [...GASOLINE_PROFILE.pids, PID_HYBRID_PACK],
};

/**
 * Driving model for {@link HYBRID_PROFILE}: the default cycle with the
 * combustion engine off while stationary (every engine-derived signal
 * agrees) and a slowly draining battery pack on PID 0x5B.
 */
export class HybridDrivingModel extends DefaultDrivingModel {
    constructor() {
        super({fuelType: FUEL_TYPE_HYBRID_GASOLINE, engineOffAtStandstill: true});
    }

    override value(pid: number, elapsedSeconds: number, jitter: (amplitude: number) => number): number | null {
        if (pid === PID_HYBRID_PACK) {
            return clamp(PACK_START_PCT - (elapsedSeconds / 3600) * PACK_DRAIN_PCT_PER_HOUR + jitter(0.5), 0, 100);
        }
        return super.value(pid, elapsedSeconds, jitter);
    }
}

export const hybridDrivingModel = (): DrivingModel => new HybridDrivingModel();
