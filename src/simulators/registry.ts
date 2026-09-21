import {DEFAULT_DIESEL_SIMULATOR} from './default-diesel';
import {DEFAULT_GASOLINE_SIMULATOR} from './default-gasoline';
import type {SimulatorDefinition} from './types';

// Every simulator that can be selected by id. Adding a vehicle means adding
// its definition to this list — ids, the registry and the listing order all
// follow from it, nothing else needs to know about the vehicle.
const DEFINITIONS = [DEFAULT_GASOLINE_SIMULATOR, DEFAULT_DIESEL_SIMULATOR] as const;

/**
 * Ids of the simulators that ship with the package. Grows as vehicles are
 * added; an id is never renamed or removed within a major version.
 */
export type SimulatorId = (typeof DEFINITIONS)[number]['id'];

export const SIMULATORS = Object.fromEntries(DEFINITIONS.map((definition) => [definition.id, definition])) as Readonly<
    Record<SimulatorId, SimulatorDefinition>
>;

export const DEFAULT_SIMULATOR_ID: SimulatorId = 'default-gasoline';

export function listSimulators(): readonly SimulatorDefinition[] {
    return DEFINITIONS;
}

// Own keys only: 'toString' or '__proto__' must not resolve to a simulator.
const isSimulatorId = (id: string): id is SimulatorId => Object.keys(SIMULATORS).includes(id);

/**
 * Looks a simulator up by id.
 *
 * @throws if the id is not registered; the message lists the valid ids.
 */
export function getSimulator(id: string): SimulatorDefinition {
    if (isSimulatorId(id)) return SIMULATORS[id];
    throw new Error(`unknown simulator "${id}" — expected ${Object.keys(SIMULATORS).join(' | ')}`);
}
