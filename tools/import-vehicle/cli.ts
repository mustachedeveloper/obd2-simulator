import {mkdirSync, readdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {assertNoLeak} from './anonymize';
import {buildCycle, toSeries} from './cycle';
import {renderDrivingModule, renderProfileModule} from './emit';
import {buildIdentity} from './identity';
import {ecuPayloads, requestOf} from './responses';
import {type Session, readSession} from './session';
import {fitSignals} from './signals';
import {deriveTraits, deriveWarmup} from './traits';

// Dev-only tool (never published): turns a directory of AutoPulse wire logs
// into the generated modules of one simulated vehicle.
//
//   npm run import-vehicle -- --source "<…>/wirelog/real-vehicle" --mask BE3EA813 \
//       --out src/vehicles/gasoline --name gasoline
//
// Sessions are matched by what the vehicle answers (engine ECU support mask,
// optionally its CVN) — never by VIN, which the logger hashes inconsistently.

const IMPORTER_VERSION = '1';

interface Options {
    source: string;
    mask: string;
    cvn: string | null;
    out: string;
    name: string;
    vinSerial: string;
    cycleSeconds: number;
    minTopSpeedKmh: number;
}

const USAGE = [
    'Usage: npm run import-vehicle -- --source <dir> --mask <hex8> --out <dir> --name <profile name> [options]',
    '',
    '  --source <dir>          directory of *.ndjson.gz wire logs',
    '  --mask <hex8>           engine ECU answer to 0100 (e.g. BE3EA813) — selects the vehicle',
    '  --cvn <hex8>            also require this engine CVN (0906), when two vehicles share a mask',
    '  --out <dir>             where profile.ts and driving.ts are written',
    '  --name <name>           VehicleProfile.name',
    '  --vin-serial <6 digits> synthetic VIN serial (default 123456)',
    '  --cycle-seconds <n>     length of the drive cycle (default 900)',
    '  --min-top-speed <km/h>  the cycle must reach this speed (default 80)',
].join('\n');

function parseOptions(argv: readonly string[]): Options {
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index] ?? '';
        const value = argv[index + 1];
        if (!flag.startsWith('--') || value === undefined) throw new Error(`unexpected argument "${flag}"`);
        values.set(flag.slice(2), value);
    }
    const required = (flag: string): string => values.get(flag) ?? fail(`--${flag} is required`);
    const hex8 = (flag: string, value: string): string =>
        /^[0-9A-F]{8}$/i.test(value) ? value.toUpperCase() : fail(`--${flag} expects 8 hex digits, got "${value}"`);
    const positive = (flag: string, fallback: number): number => {
        const parsed = Number(values.get(flag) ?? fallback);
        return Number.isInteger(parsed) && parsed > 0 ? parsed : fail(`--${flag} expects a positive integer`);
    };
    const cvn = values.get('cvn');
    return {
        source: required('source'),
        mask: hex8('mask', required('mask')),
        cvn: cvn === undefined ? null : hex8('cvn', cvn),
        out: required('out'),
        name: required('name'),
        vinSerial: values.get('vin-serial') ?? '123456',
        cycleSeconds: positive('cycle-seconds', 900),
        minTopSpeedKmh: positive('min-top-speed', 80),
    };
}

function fail(message: string): never {
    throw new Error(message);
}

// The engine ECU (first responder) answered 0100 with the mask, and — when
// both are known — 0906 with the CVN.
function isVehicle(session: Session, options: Options): boolean {
    const first = (request: string, prefix: string): string[] =>
        session.exchanges
            .filter((exchange) => requestOf(exchange.c) === request)
            .map((exchange) => ecuPayloads(exchange.c, exchange.r)[0] ?? '')
            .filter((payload) => payload.startsWith(prefix));
    const masks = first('0100', '4100');
    const cvns = first('0906', '490601');
    // startsWith: a padding adapter prints AA bytes after the four mask bytes.
    const cvnMatches = options.cvn === null || cvns.length === 0 || cvns.some((cvn) => cvn.startsWith(`490601${options.cvn}`));
    return masks.some((mask) => mask.startsWith(`4100${options.mask}`)) && cvnMatches;
}

function loadSessions(options: Options): Session[] {
    const files = readdirSync(options.source)
        .filter((file) => file.endsWith('.ndjson.gz'))
        .sort();
    if (files.length === 0) fail(`no *.ndjson.gz files in ${options.source}`);
    const sessions = files.flatMap((file) => {
        try {
            return [readSession(join(options.source, file))];
        } catch (error) {
            console.warn(`skipped ${file}: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    });
    return sessions.filter((session) => isVehicle(session, options));
}

const isoDate = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

function run(options: Options): void {
    const sessions = loadSessions(options);
    if (sessions.length === 0) fail(`no session in ${options.source} matches mask ${options.mask}`);
    const exchanges = sessions.flatMap((session) => session.exchanges);
    const samples = sessions.flatMap((session) => session.samples);

    const identity = buildIdentity(exchanges, {name: options.name, vinSerial: options.vinSerial});
    const measured = deriveTraits(samples);
    const traits = {
        ...measured,
        ...(measured.coolantTargetC === undefined
            ? {}
            : deriveWarmup(
                  sessions.map((session) => session.samples),
                  measured.coolantTargetC,
              )),
    };
    const {signals, diagnosis} = fitSignals(
        sessions.map((session) => session.samples),
        identity.profile.pids,
    );
    const cycle = buildCycle(
        sessions.map((session) => toSeries(session.samples)),
        {seconds: options.cycleSeconds, minTopSpeedKmh: options.minTopSpeedKmh},
    );
    const started = sessions.map((session) => session.startedAt).filter((t) => t > 0);
    if (started.length === 0) fail('no matching session has a header record with a start time — cannot state the provenance');
    const provenance = {
        sessions: sessions.length,
        from: isoDate(Math.min(...started)),
        to: isoDate(Math.max(...started)),
        importerVersion: IMPORTER_VERSION,
    };

    const secrets = [...identity.secrets, ...sessions.flatMap((session) => session.secrets)];
    const modules = {
        'profile.ts': renderProfileModule(identity.profile, provenance),
        'driving.ts': renderDrivingModule(cycle, traits, signals),
    };
    for (const source of Object.values(modules)) assertNoLeak(source, secrets);

    const out = resolve(options.out);
    mkdirSync(out, {recursive: true});
    for (const [file, source] of Object.entries(modules)) writeFileSync(join(out, file), source);

    const hexPids = (pids: readonly number[]) => pids.map((pid) => pid.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    console.log(`${sessions.length} sessions, ${exchanges.length} exchanges, ${samples.length} samples → ${out}`);
    console.log(
        `PIDs served: ${identity.profile.pids.length}; advertised without an encoder: ${hexPids(identity.report.unsupportedPids) || 'none'}`,
    );
    if (identity.report.missing.length > 0) console.log(`never recorded: ${identity.report.missing.join(' ')}`);
    if (identity.report.refusesClearWhileRunning) {
        console.log('note: the vehicle refuses mode 04 while running (7F0422) — consider clearRequiresEngineOff');
    }
    console.log(`traits: ${JSON.stringify(traits)}`);
    const fittedPids = Object.keys(signals).map(Number);
    const sloped = fittedPids.filter((pid) => {
        const fit = signals[pid];
        return fit !== undefined && (fit.perLoadPct !== 0 || fit.perKrpm !== 0 || fit.perKmh !== 0);
    });
    for (const line of diagnosis) {
        const explained = line.rSquared === null ? '   —' : line.rSquared.toFixed(2);
        console.log(`  PID ${hexPids([line.pid])}  n=${String(line.samples).padStart(6)}  R²=${explained}  → ${line.outcome}`);
    }
    console.log(`signals: ${fittedPids.length} fitted (${hexPids(sloped)} follow the driving state, the rest are constants)`);
    const standstill = cycle.speedKmh.filter((speed) => speed < 1).length / cycle.speedKmh.length;
    const meanSpeed = cycle.speedKmh.reduce((sum, speed) => sum + speed, 0) / cycle.speedKmh.length;
    console.log(
        `cycle: ${cycle.speedKmh.length} s, top ${Math.max(...cycle.speedKmh)} km/h, mean ${meanSpeed.toFixed(0)} km/h, ${(standstill * 100).toFixed(0)} % standstill, max ${Math.max(...cycle.rpm)} rpm`,
    );
}

try {
    run(parseOptions(process.argv.slice(2)));
} catch (error) {
    console.error(`import-vehicle: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    process.exit(1);
}
