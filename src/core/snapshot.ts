import type {EngineSnapshot, IgnitionState} from './types';
import {normalizeDtc} from './j1979';

// Validation of scenario inputs that may come from disk or the network:
// snapshots are checked in full before the engine applies them, and fault
// queue sizes are bounded so a typo cannot allocate gigabytes.

const MAX_QUEUED_FAULTS = 1000;
const IGNITION_STATES: readonly IgnitionState[] = ['off', 'key-on', 'running'];
const ADAPTER_FAULT_SET: ReadonlySet<string> = new Set([
    'BUFFER FULL',
    'CAN ERROR',
    'BUS ERROR',
    'DATA ERROR',
    'STOPPED',
    'UNABLE TO CONNECT',
    'NO DATA',
]);

/**
 * Queue sizes for fault injection: a typo must not allocate gigabytes.
 */
export function checkQueueCount(count: number): number {
    if (!Number.isInteger(count) || count < 0 || count > MAX_QUEUED_FAULTS) {
        throw new Error(`count must be an integer in 0-${MAX_QUEUED_FAULTS}, got ${count}`);
    }
    return count;
}

export const isPid = (pid: number): boolean => Number.isInteger(pid) && pid >= 0 && pid <= 0xff;

// Snapshots may come from disk or the network: everything is checked
// before any field of the engine changes, so a bad snapshot leaves it intact.
export function parseSnapshot(snapshot: EngineSnapshot): EngineSnapshot {
    if (!snapshot || typeof snapshot !== 'object') throw new Error('snapshot must be an object');
    const {link, overrides, freezeFrame} = snapshot;
    if (!link || typeof link !== 'object' || typeof link.echo !== 'boolean' || typeof link.protocol !== 'string') {
        throw new Error('snapshot.link must be a LinkState');
    }
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))
        throw new Error('snapshot.overrides must be an object');
    const parsedOverrides = Object.fromEntries(
        Object.entries(overrides).map(([pid, value]) => {
            const key = Number(pid);
            if (!isPid(key) || (value !== null && !Number.isFinite(value)))
                throw new Error(`snapshot.overrides: bad entry ${pid} = ${value}`);
            return [key, value];
        }),
    );
    if (!(IGNITION_STATES as readonly string[]).includes(snapshot.ignition))
        throw new Error(`snapshot.ignition: unknown state "${snapshot.ignition}"`);
    if (!Array.isArray(snapshot.pendingFaults) || snapshot.pendingFaults.some((fault) => !ADAPTER_FAULT_SET.has(fault))) {
        throw new Error('snapshot.pendingFaults: unknown fault');
    }
    if (
        freezeFrame !== null &&
        (!Array.isArray(freezeFrame) || freezeFrame.some(([pid, data]) => !isPid(pid) || !Array.isArray(data)))
    ) {
        throw new Error('snapshot.freezeFrame must be null or [pid, bytes][]');
    }
    const codes = (list: readonly string[], name: string) => {
        if (!Array.isArray(list)) throw new Error(`snapshot.${name} must be an array`);
        return list.map(normalizeDtc);
    };
    return {
        link: {...link},
        storedDtcs: codes(snapshot.storedDtcs, 'storedDtcs'),
        pendingDtcs: codes(snapshot.pendingDtcs, 'pendingDtcs'),
        permanentDtcs: codes(snapshot.permanentDtcs, 'permanentDtcs'),
        freezeFrame: freezeFrame ? freezeFrame.map(([pid, data]) => [pid, [...data]] as const) : null,
        overrides: parsedOverrides,
        ignition: snapshot.ignition,
        pendingFaults: [...snapshot.pendingFaults],
    };
}
