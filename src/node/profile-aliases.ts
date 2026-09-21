import {gasolineDrivingModel} from '../profiles/gasoline';
import {HYBRID_PROFILE, hybridDrivingModel} from '../profiles/hybrid';
import {REFERENCE_PROFILE} from '../profiles/reference';
import {SIMULATORS} from '../simulators/registry';
import type {SimulatorDefinition} from '../simulators/types';

// The CLI's original `--profile <name>` selection, kept working on top of
// the simulator registry. 'hybrid' and 'reference' are not selectable
// simulators; they only exist behind this flag.

export type ProfileAlias = 'gasoline' | 'diesel' | 'hybrid' | 'reference';

export const PROFILE_ALIASES: Readonly<Record<ProfileAlias, SimulatorDefinition>> = {
    gasoline: SIMULATORS['default-gasoline'],
    diesel: SIMULATORS['default-diesel'],
    hybrid: {
        id: 'profile-hybrid',
        label: 'Hybrid (--profile hybrid)',
        description: 'Gasoline hybrid: combustion engine off at standstill, battery pack on PID 0x5B.',
        kind: 'synthetic',
        profile: HYBRID_PROFILE,
        createModel: hybridDrivingModel,
    },
    reference: {
        id: 'profile-reference',
        label: 'Reference (--profile reference)',
        description: 'The default gasoline vehicle under its original name.',
        kind: 'synthetic',
        profile: REFERENCE_PROFILE,
        createModel: gasolineDrivingModel,
    },
};
