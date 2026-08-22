#!/usr/bin/env node
import {SimulatorEngine} from '../core/SimulatorEngine';
import {GASOLINE_PROFILE} from '../profiles/gasoline';
import {DIESEL_PROFILE, dieselDrivingModel} from '../profiles/diesel';
import {REFERENCE_PROFILE} from '../profiles/reference';
import type {VehicleProfile} from '../core/types';
import {ADAPTER_PRESETS} from '../adapters/presets';
import {createTcpServer} from './tcp-server';
import {createControlServer} from './control-server';
import {CONTROL_HELP, applyControlCommand} from './control';
import {USAGE, parseArgs} from './cli-args';

// Tiny hand-rolled CLI (zero dependencies):
//   npx obd2-simulator --port 35000 --profile diesel --adapter clone --dtc P0301 --seed 7

const parsed = parseArgs(process.argv.slice(2));
if (parsed.kind === 'help') {
    console.log(USAGE);
    process.exit(0);
}
if (parsed.kind === 'error') {
    console.error(`obd2-simulator: ${parsed.message}\n`);
    console.error(USAGE);
    process.exit(1);
}

const {options} = parsed;
const PROFILES: Record<typeof options.profile, VehicleProfile> = {gasoline: GASOLINE_PROFILE, diesel: DIESEL_PROFILE, reference: REFERENCE_PROFILE};
const profile = PROFILES[options.profile];
const adapter = ADAPTER_PRESETS[options.adapter];

const live = new Set<SimulatorEngine>();
// Successful control commands, replayed on every engine created later so a
// scenario set up before (or between) app connections still applies.
let scenario: readonly string[] = [];
const server = createTcpServer({
    port: options.port,
    host: options.host,
    onEngine: (engine) => {
        live.add(engine);
        return () => live.delete(engine);
    },
    engineFactory: () => {
        const engine = new SimulatorEngine({
            profile,
            model: options.profile === 'diesel' ? dieselDrivingModel() : undefined,
            adapter,
            seed: options.seed,
        });
        for (const code of options.dtcs) engine.injectDtc(code);
        for (const line of scenario) applyControlCommand(line, [engine]);
        return engine;
    },
    onListening: (port) => {
        console.log(
            `obd2-simulator: ${profile.name} vehicle (VIN ${profile.vin}) behind a "${adapter.banner}" adapter (${adapter.name}) listening on ${options.host}:${port}`,
        );
        console.log('Connect any OBD app to this host:port as a WiFi ELM327 adapter. Ctrl+C to stop.');
    },
    onConnection: (remote) => console.log(`client connected: ${remote}`),
    onClientError: (remote, error) => console.error(`client ${remote}: ${error.message}`),
    onError: (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        const hint = code === 'EADDRINUSE' ? ` — port ${options.port} is taken, try --port <n>` : code === 'EACCES' ? ' — no permission for that port' : '';
        console.error(`obd2-simulator: ${error.message}${hint}`);
        process.exit(1);
    },
});

const control =
    options.control === null
        ? null
        : createControlServer({
              port: options.control,
              host: options.host,
              engines: () => [...live],
              onApplied: (line, reply) => {
                  if (reply.startsWith('ok ') && !/^(status|help)\b/i.test(line)) scenario = [...scenario, line];
              },
              onListening: (port) => console.log(`control channel on ${options.host}:${port} — ${CONTROL_HELP.join(' | ')}`),
              onClientError: (remote, error) => console.error(`control client ${remote}: ${error.message}`),
              onError: (error) => {
                  console.error(`obd2-simulator: control channel: ${error.message}`);
                  process.exit(1);
              },
          });

const SHUTDOWN_GRACE_MS = 500;
const shutdown = () => {
    console.log('\nobd2-simulator: shutting down');
    // close() waits for clients to hang up; an OBD app polling every 100 ms
    // never will, so exit after a short grace period either way.
    server.close(() => process.exit(0));
    control?.close();
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
