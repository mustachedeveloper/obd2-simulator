import {ADAPTER_PRESETS} from '../adapters/presets';
import {normalizeDtc} from '../core/j1979';

// Pure argument parsing for the CLI (no process access), so it is testable
// and every malformed value produces a specific message instead of the
// generic usage text.

export interface CliOptions {
    port: number;
    host: string;
    profile: 'gasoline' | 'diesel';
    adapter: string;
    dtcs: readonly string[];
    seed: number;
}

export type CliParseResult = {kind: 'run'; options: CliOptions} | {kind: 'help'} | {kind: 'error'; message: string};

export const DEFAULT_CLI_OPTIONS: CliOptions = {
    port: 35000,
    host: '0.0.0.0',
    profile: 'gasoline',
    adapter: 'default',
    dtcs: [],
    seed: 42,
};

const ADAPTER_NAMES = Object.keys(ADAPTER_PRESETS).join(' | ');

export const USAGE = [
    'Usage: obd2-simulator [options]',
    '',
    `  --port, -p <n>       TCP port to listen on (default ${DEFAULT_CLI_OPTIONS.port})`,
    `  --host <address>     interface to bind (default ${DEFAULT_CLI_OPTIONS.host}; 127.0.0.1 for local-only)`,
    '  --profile <name>     gasoline | diesel (default gasoline)',
    `  --adapter <name>     ${ADAPTER_NAMES} (default default)`,
    '  --dtc <code>         inject a stored DTC, repeatable (e.g. --dtc P0301)',
    `  --seed <n>           jitter seed for reproducible runs (default ${DEFAULT_CLI_OPTIONS.seed})`,
    '  --help, -h           show this help',
    '',
    'Point any OBD app at this host:port as a WiFi ELM327 adapter.',
].join('\n');

class CliArgError extends Error {}
class HelpRequested extends Error {}

const fail = (message: string): never => {
    throw new CliArgError(message);
};

const integer = (flag: string, value: string | undefined): number => {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && String(parsed) === value ? parsed : fail(`${flag} expects an integer, got "${value ?? ''}"`);
};

const MAX_PORT = 65535;
const port = (flag: string, value: string | undefined): number => {
    const parsed = integer(flag, value);
    return parsed >= 0 && parsed <= MAX_PORT ? parsed : fail(`${flag} expects a port in 0-${MAX_PORT}, got ${parsed}`);
};

const profile = (value: string | undefined): CliOptions['profile'] =>
    value === 'gasoline' || value === 'diesel' ? value : fail(`--profile expects gasoline | diesel, got "${value ?? ''}"`);

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
        if (error instanceof CliArgError) return {kind: 'error', message: error.message};
        throw error;
    }
}

function parse(argv: readonly string[]): CliOptions {
    let options = DEFAULT_CLI_OPTIONS;
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
            case '--profile':
                options = {...options, profile: profile(next())};
                break;
            case '--adapter':
                options = {...options, adapter: adapter(next())};
                break;
            case '--dtc':
                options = {...options, dtcs: [...options.dtcs, dtc(next())]};
                break;
            case '--seed':
                options = {...options, seed: integer(arg, next())};
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
