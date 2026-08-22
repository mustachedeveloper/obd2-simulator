import {ADAPTER_PRESETS} from '../adapters/presets';
import type {SimulatorEngine} from '../core/SimulatorEngine';
import {ADAPTER_FAULTS, type AdapterFault, type IgnitionState} from '../core/types';
import {normalizeDtc} from '../core/j1979';

// Line protocol for steering live engines while an app is connected: one
// command per line, one 'ok …' / 'error …' reply per line. Pure — the
// control server only moves the strings.

const IGNITION_STATES: readonly IgnitionState[] = ['off', 'key-on', 'running'];

export const CONTROL_HELP = [
    'dtc <code> [stored|pending|permanent]',
    'set <pid-hex> <value|null>',
    'ignition off|key-on|running',
    'fail <ERROR TEXT> [count]',
    'adapter <preset>',
    'clear dtcs|overrides|faults',
    'status',
    'help',
];

class ControlError extends Error {}

// A function declaration (not a const) so TypeScript narrows after calls.
function fail(message: string): never {
    throw new ControlError(message);
}

const isIgnition = (value: string): value is IgnitionState => (IGNITION_STATES as readonly string[]).includes(value);
const isFault = (value: string): value is AdapterFault => (ADAPTER_FAULTS as readonly string[]).includes(value);

function apply(line: string, engines: readonly SimulatorEngine[]): string {
    const [verb = '', ...args] = line.trim().split(/\s+/);
    const each = (action: (engine: SimulatorEngine) => void, summary: string): string => {
        for (const engine of engines) action(engine);
        return `ok ${engines.length} engine(s): ${summary}`;
    };
    switch (verb.toLowerCase()) {
        case 'dtc': {
            const [code, status = 'stored'] = args;
            if (!code) fail('dtc expects a code, e.g. dtc P0301 [stored|pending|permanent]');
            if (status !== 'stored' && status !== 'pending' && status !== 'permanent')
                fail(`dtc expects stored|pending|permanent, got "${status}"`);
            const normalized = normalizeDtc(code);
            return each((engine) => engine.injectDtc(normalized, status), `injected ${normalized} (${status})`);
        }
        case 'set': {
            const [pidHex = '', raw] = args;
            const pid = Number.parseInt(pidHex ?? '', 16);
            if (!/^[0-9A-Fa-f]{2}$/.test(pidHex ?? '') || Number.isNaN(pid))
                fail(`set expects a two-digit hex PID, got "${pidHex ?? ''}"`);
            const value = raw === 'null' ? null : Number(raw);
            if (raw === undefined || (value !== null && !Number.isFinite(value)))
                fail(`set expects a number or null, got "${raw ?? ''}"`);
            const label = pidHex.toUpperCase();
            return each((engine) => engine.override(pid, value), `PID ${label} = ${value === null ? 'NO DATA' : value}`);
        }
        case 'ignition': {
            const [state] = args;
            if (!state || !isIgnition(state)) fail(`ignition expects ${IGNITION_STATES.join('|')}, got "${state ?? ''}"`);
            return each((engine) => engine.setIgnition(state), `ignition ${state}`);
        }
        case 'fail': {
            const last = args[args.length - 1] ?? '';
            const hasCount = args.length > 1 && /^\d+$/.test(last);
            const count = hasCount ? Number.parseInt(last, 10) : 1;
            const text = (hasCount ? args.slice(0, -1) : args).join(' ').toUpperCase();
            if (!isFault(text)) fail(`fail expects one of ${ADAPTER_FAULTS.join(' | ')}, got "${text}"`);
            return each((engine) => engine.failNext(text, count), `next ${count} request(s) → ${text}`);
        }
        case 'adapter': {
            const [preset = ''] = args;
            const persona = ADAPTER_PRESETS[preset];
            if (!persona) return fail(`adapter expects ${Object.keys(ADAPTER_PRESETS).join('|')}, got "${preset}"`);
            return each((engine) => engine.setAdapter(persona), `adapter ${persona.name}`);
        }
        case 'clear': {
            const [what] = args;
            if (what === 'dtcs') return each((engine) => engine.clearDtcs(), 'DTCs cleared');
            if (what === 'overrides') return each((engine) => engine.clearOverrides(), 'overrides cleared');
            if (what === 'faults') return each((engine) => engine.clearFaults(), 'faults cleared');
            return fail(`clear expects dtcs|overrides|faults, got "${what ?? ''}"`);
        }
        case 'status':
            return `ok ${JSON.stringify(
                engines.map((engine) => ({
                    ignition: engine.ignition,
                    adapter: engine.adapter.name,
                    storedDtcs: engine.storedDtcs,
                    pendingDtcs: engine.pendingDtcs,
                    permanentDtcs: engine.permanentDtcs,
                    overrides: engine.overrides,
                    pendingFaults: engine.pendingFaults,
                })),
            )}`;
        case 'help':
            return `ok commands: ${CONTROL_HELP.join(' | ')}`;
        default:
            return fail(`unknown command "${verb}" — try help`);
    }
}

export function applyControlCommand(line: string, engines: readonly SimulatorEngine[]): string {
    try {
        return apply(line, engines);
    } catch (error) {
        if (error instanceof Error) return `error ${error.message}`;
        throw error;
    }
}
