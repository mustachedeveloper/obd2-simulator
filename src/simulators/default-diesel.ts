import {DIESEL_PROFILE, dieselDrivingModel} from '../profiles/diesel';
import type {SimulatorDefinition} from './types';

export const DEFAULT_DIESEL_SIMULATOR: SimulatorDefinition & {readonly id: 'default-diesel'} = {
    id: 'default-diesel',
    label: 'Default diesel',
    description: 'Compression-ignition passenger car (DPF, NOx, AdBlue) on the default driving cycle.',
    kind: 'synthetic',
    profile: DIESEL_PROFILE,
    createModel: dieselDrivingModel,
};
