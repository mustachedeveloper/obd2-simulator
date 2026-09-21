import type {VehicleProfile} from '../core/types';
import {GASOLINE_PROFILE} from './gasoline';

/**
 * The vehicle the adapter presets were measured on. It is the same car the
 * default gasoline vehicle is recorded from, so this is that profile under
 * its original name.
 */
export const REFERENCE_PROFILE: VehicleProfile = {...GASOLINE_PROFILE, name: 'reference'};
