import {SimulatorEngine, type SimulatorEngineOptions} from '../core/SimulatorEngine';
import {DEFAULT_SIMULATOR_ID, getSimulator} from './registry';
import type {SimulatorDefinition} from './types';

/**
 * Engine options minus the profile, which the selected simulator decides.
 * `model` stays available for callers that drive the vehicle themselves.
 */
export type CreateSimulatorOptions = Omit<SimulatorEngineOptions, 'profile'>;

/**
 * Builds an engine for a selectable simulator: a registered id, or a
 * definition of your own. No selection runs the default gasoline simulator.
 *
 * @throws if the id is not registered.
 */
export function createSimulator(
    simulator: string | SimulatorDefinition = DEFAULT_SIMULATOR_ID,
    options: CreateSimulatorOptions = {},
): SimulatorEngine {
    const definition = typeof simulator === 'string' ? getSimulator(simulator) : simulator;
    return new SimulatorEngine({
        ...options,
        profile: definition.profile,
        model: options.model ?? definition.createModel(),
    });
}
