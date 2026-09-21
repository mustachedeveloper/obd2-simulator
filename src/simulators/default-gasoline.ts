import {GASOLINE_PROFILE, gasolineDrivingModel} from '../profiles/gasoline';
import {PROVENANCE} from '../vehicles/gasoline/profile';
import type {SimulatorDefinition} from './types';

/**
 * The simulator that runs when nothing is selected.
 */
export const DEFAULT_GASOLINE_SIMULATOR: SimulatorDefinition & {readonly id: 'default-gasoline'} = {
    id: 'default-gasoline',
    label: 'Default gasoline',
    description: 'Spark-ignition passenger car recorded from a real vehicle: 3 ECUs on CAN 29-bit, replaying a real drive.',
    kind: 'recorded',
    provenance: PROVENANCE,
    profile: GASOLINE_PROFILE,
    createModel: gasolineDrivingModel,
};
