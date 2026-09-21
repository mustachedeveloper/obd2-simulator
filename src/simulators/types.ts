import type {DrivingModel, VehicleProfile} from '../core/types';

/**
 * 'synthetic' → hand-written, idealized vehicle; 'recorded' → identity and
 * driving behaviour derived from wire logs of a real vehicle.
 */
export type SimulatorKind = 'synthetic' | 'recorded';

/**
 * Where a recorded simulator's data came from. Never carries anything that
 * identifies the vehicle or its owner.
 */
export interface SimulatorProvenance {
    /**
     * Number of recording sessions the data was derived from.
     */
    sessions: number;
    /**
     * ISO dates (YYYY-MM-DD) of the first and last session.
     */
    from: string;
    to: string;
    /**
     * Version of the import tool that generated the data.
     */
    importerVersion: string;
}

/**
 * One selectable simulator: the vehicle profile together with the driving
 * model that belongs to it, so the two can never be mismatched. Every
 * vehicle — synthetic or recorded — is described this way.
 */
interface SimulatorDefinitionBase {
    /**
     * Stable kebab-case id, used for selection (CLI, {@link createSimulator}).
     */
    id: string;
    label: string;
    description: string;
    profile: VehicleProfile;
    /**
     * A fresh model per engine — models may carry state.
     */
    createModel: () => DrivingModel;
}

/**
 * A 'recorded' simulator always says where its data came from; a
 * 'synthetic' one has nothing to say.
 */
export type SimulatorDefinition = SimulatorDefinitionBase &
    ({kind: 'synthetic'; provenance?: undefined} | {kind: 'recorded'; provenance: SimulatorProvenance});
