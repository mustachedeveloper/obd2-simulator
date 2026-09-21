import {ADAPTER_PRESETS} from '../adapters/presets';
import {normalizeDtc} from '../core/j1979';
import {DEFAULT_SIMULATOR_ID, SIMULATORS, getSimulator} from '../simulators/registry';
import type {SimulatorDefinition} from '../simulators/types';
import {PROFILE_ALIASES, type ProfileAlias} from './profile-aliases';

// Pure argument parsing for the CLI (no process access), so it is testable
// and every malformed value produces a specific message instead of the
// generic usage text.

export interface CliOptions {
    port: number;
    host: string;
    // Chosen with --simulator <id>, or through the older --profile <name>.
    simulator: SimulatorDefinition;
    adapter: string;
    dtcs: readonly string[];
    seed: number;
    // Control-channel port; null → no control server.
    control: number | null;
}

export type CliParseResult =
    | {kind: 'run'; options: CliOptions}
    | {kind: 'help'}
    | {kind: 'list-simulators'}
    | {kind: 'error'; message: string};

export const DEFAULT_CLI_OPTIONS: CliOptions = {
    port: 35000,
    host: '0.0.0.0',
    simulator: SIMULATORS[DEFAULT_SIMULATOR_ID],
    adapter: 'default',
    dtcs: [],
    seed: 42,
    control: null,
};

const ADAPTER_NAMES = Object.keys(ADAPTER_PRESETS).join(' | ');
const SIMULATOR_IDS = Object.keys(SIMULATORS).join(' | ');

export const USAGE = [
    'Usage: obd2-simulator [options]',
    '',
    `  --port, -p <n>       TCP port to listen on (default ${DEFAULT_CLI_OPTIONS.port})`,
    `  --host <address>     interface to bind (default ${DEFAULT_CLI_OPTIONS.host}; 127.0.0.1 for local-only)`,
    `  --simulator <id>     ${SIMULATOR_IDS} (default ${DEFAULT_SIMULATOR_ID})`,
    '  --list-simulators    describe the selectable simulators and exit',
    '  --profile <name>     older spelling: gasoline | diesel | hybrid | reference (reference = 2-ECU CAN 29-bit car)',
    `  --adapter <name>     ${ADAPTER_NAMES} (default default)`,
    '  --dtc <code>         inject a stored DTC, repeatable (e.g. --dtc P0301)',
    `  --seed <n>           jitter seed for reproducible runs (default ${DEFAULT_CLI_OPTIONS.seed})`,
    '  --control <n>        also listen on this port for steering commands (dtc, set, ignition, fail, ...)',
    '  --help, -h           show this help',
    '',
    'Point any OBD app at this host:port as a WiFi ELM327 adapter.',
].join('\n');

class CliArgError extends Error {}
class HelpRequested extends Error {}
class ListRequested extends Error {}

const fail = (message: string): never => {
    throw new CliArgError(message);
};

const integer = (flag: string, value: string | undefined): number => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && String(parsed) === value
        ? parsed
        : fail(`${flag} expects an integer, got "${value ?? ''}"`);
};

const MAX_PORT = 65535;
const port = (flag: string, value: string | undefined): number => {
    const parsed = integer(flag, value);
    return parsed >= 0 && parsed <= MAX_PORT ? parsed : fail(`${flag} expects a port in 0-${MAX_PORT}, got ${parsed}`);
};

const PROFILES = Object.keys(PROFILE_ALIASES) as readonly ProfileAlias[];
const profile = (value: string | undefined): SimulatorDefinition => {
    const alias = PROFILES.find((name) => name === value);
    return alias ? PROFILE_ALIASES[alias] : fail(`--profile expects ${PROFILES.join(' | ')}, got "${value ?? ''}"`);
};

const simulator = (value: string | undefined): SimulatorDefinition => {
    try {
        return getSimulator(value ?? '');
    } catch {
        return fail(`--simulator expects ${SIMULATOR_IDS}, got "${value ?? ''}"`);
    }
};

const adapter = (value: string | undefined): string =>
    value !== undefined && value in ADAPTER_PRESETS ? value : fail(`--adapter expects ${ADAPTER_NAMES}, got "${value ?? ''}"`);

const dtc = (value: string | undefined): string => {
    try {
        return normalizeDtc(value ?? '');
    } catch (error) {
        return fail((error as Error).message);
    }
};

export function parseArgs(argv: readonly string[]): CliParseResult {
    try {
        return {kind: 'run', options: parse(argv)};
    } catch (error) {
        if (error instanceof HelpRequested) return {kind: 'help'};
        if (error instanceof ListRequested) return {kind: 'list-simulators'};
        if (error instanceof CliArgError) return {kind: 'error', message: error.message};
        throw error;
    }
}

function parse(argv: readonly string[]): CliOptions {
    let options = DEFAULT_CLI_OPTIONS;
    // The flag that picked the vehicle; the two spellings cannot be combined.
    let selectedBy: string | null = null;
    const select = (flag: string, definition: SimulatorDefinition): CliOptions => {
        if (selectedBy !== null && selectedBy !== flag) fail('use either --simulator or --profile, not both');
        selectedBy = flag;
        return {...options, simulator: definition};
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => argv[++i];
        switch (arg) {
            case '--port':
            case '-p':
                options = {...options, port: port(arg, next())};
                break;
            case '--host':
                options = {...options, host: next() ?? fail('--host expects an address')};
                break;
            case '--simulator':
                options = select(arg, simulator(next()));
                break;
            case '--profile':
                options = select(arg, profile(next()));
                break;
            case '--list-simulators':
                throw new ListRequested();
            case '--adapter':
                options = {...options, adapter: adapter(next())};
                break;
            case '--dtc':
                options = {...options, dtcs: [...options.dtcs, dtc(next())]};
                break;
            case '--seed':
                options = {...options, seed: integer(arg, next())};
                break;
            case '--control':
                options = {...options, control: port(arg, next())};
                break;
            case '--help':
            case '-h':
                throw new HelpRequested();
            default:
                fail(`unknown option "${arg}"`);
        }
    }
    return options;
}
