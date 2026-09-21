import {DefaultDrivingModel} from '../core/DefaultDrivingModel';
import type {DrivingModel, VehicleProfile} from '../core/types';
import {CYCLE, TRAITS} from '../vehicles/gasoline/driving';
import {PROFILE} from '../vehicles/gasoline/profile';

/**
 * The default vehicle, recorded from a real car: a 2025 spark-ignition
 * passenger car on ISO 15765-4 CAN 29/500 with an engine ECU, a
 * transmission ECU and a third module that rejects DTC requests
 * (7F xx 10). PID set, readiness, in-use counters, mode 06 results and the
 * ECU identities are what the car answered; only the VIN serial is
 * synthetic. Generated — see src/vehicles/gasoline.
 */
export const GASOLINE_PROFILE: VehicleProfile = PROFILE;

/**
 * Driving model matching the profile: a recorded 15-minute drive (town and
 * country road) replayed in a loop, with the car's measured idle speed,
 * operating temperature, charging voltage and fuel trim.
 */
export const gasolineDrivingModel = (): DrivingModel => new DefaultDrivingModel({traits: TRAITS, cycle: CYCLE});
