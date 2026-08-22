import {SimulatorEngine} from '../core/SimulatorEngine';
import {GASOLINE_PROFILE} from '../profiles/gasoline';
import {DIESEL_PROFILE, dieselDrivingModel} from '../profiles/diesel';
import type {VehicleProfile} from '../core/types';
import {ADAPTER_PRESETS} from '../adapters/presets';
import {createTcpServer} from './tcp-server';

// Tiny hand-rolled CLI (zero dependencies):
//   npx obd2-simulator --port 35000 --profile diesel --adapter clone --dtc P0301 --seed 7

interface CliOptions {
    port: number;
    profile: 'gasoline' | 'diesel';
    adapter: string;
    dtcs: string[];
    seed: number;
}

function parseArgs(argv: string[]): CliOptions | null {
    const options: CliOptions = {port: 35000, profile: 'gasoline', adapter: 'default', dtcs: [], seed: 42};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => argv[++i];
        if (arg === '--port' || arg === '-p') options.port = Number.parseInt(next() ?? '', 10);
        else if (arg === '--profile') {
            const value = next();
            if (value !== 'gasoline' && value !== 'diesel') return null;
            options.profile = value;
        } else if (arg === '--adapter') {
            const value = next() ?? '';
            if (!(value in ADAPTER_PRESETS)) return null;
            options.adapter = value;
        } else if (arg === '--dtc') options.dtcs.push((next() ?? '').toUpperCase());
        else if (arg === '--seed') options.seed = Number.parseInt(next() ?? '', 10);
        else if (arg === '--help' || arg === '-h') return null;
        else return null;
    }
    if (!Number.isFinite(options.port) || !Number.isFinite(options.seed)) return null;
    return options;
}

const options = parseArgs(process.argv.slice(2));
if (!options) {
    console.log(
        [
            'Usage: obd2-simulator [options]',
            '',
            '  --port, -p <n>       TCP port to listen on (default 35000)',
            '  --profile <name>     gasoline | diesel (default gasoline)',
            `  --adapter <name>     ${Object.keys(ADAPTER_PRESETS).join(' | ')} (default default)`,
            '  --dtc <code>         inject a stored DTC, repeatable (e.g. --dtc P0301)',
            '  --seed <n>           jitter seed for reproducible runs (default 42)',
            '',
            'Point any OBD app at this host:port as a WiFi ELM327 adapter.',
        ].join('\n'),
    );
    process.exit(options === null && process.argv.slice(2).some((a) => a === '--help' || a === '-h') ? 0 : 1);
}

const profile: VehicleProfile = options.profile === 'diesel' ? DIESEL_PROFILE : GASOLINE_PROFILE;
const adapter = ADAPTER_PRESETS[options.adapter];

createTcpServer({
    port: options.port,
    engineFactory: () => {
        const engine = new SimulatorEngine({
            profile,
            model: options.profile === 'diesel' ? dieselDrivingModel() : undefined,
            adapter,
            seed: options.seed,
        });
        for (const code of options.dtcs) engine.injectDtc(code);
        return engine;
    },
    onListening: (port) => {
        console.log(
            `obd2-simulator: ${profile.name} vehicle (VIN ${profile.vin}) behind a "${adapter.banner}" adapter (${adapter.name}) listening on port ${port}`,
        );
        console.log('Connect any OBD app to this host:port as a WiFi ELM327 adapter. Ctrl+C to stop.');
    },
    onConnection: (remote) => console.log(`client connected: ${remote}`),
});
