# obd2-simulator

[![npm](https://img.shields.io/npm/v/obd2-simulator)](https://www.npmjs.com/package/obd2-simulator)
[![CI](https://github.com/mustachedeveloper/obd2-simulator/actions/workflows/ci.yml/badge.svg)](https://github.com/mustachedeveloper/obd2-simulator/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/obd2-simulator)](./LICENSE)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)

A zero-dependency **ELM327 / OBD-II vehicle simulator** — a fake car for testing diagnostic apps.

Feed it the exact ASCII commands a real ELM327 adapter receives; get back the exact bytes a real adapter prints — echo, spaces, `\r\r>` prompt framing, `SEARCHING...`, ISO-TP multi-frame responses, one line per ECU, negative responses, supported-PID masks. Your parsers, schedulers and UI run their **real code paths** against it. Output is checked against recordings of real adapters ([`tests/fixtures/wirelog`](./tests/fixtures/wirelog)).

- **Zero runtime dependencies.** Pure TypeScript core, no native modules.
- **Runs anywhere.** React Native (Hermes), Node ≥ 18, browsers.
- **Deterministic.** Seeded PRNG + injectable clock: same seed, same output — no flaky tests.
- **A whole vehicle, not just RPM.** Live data with a driving cycle, multiple ECUs, fault-code lifecycle, freeze frame, monitor tests, readiness, VIN & vehicle info.
- **A real adapter in front of it.** Personas measured from actual devices: latency, hint handling, spaces, protocol search time, banner quirks.

## Install

```sh
npm install obd2-simulator
```

## Quick start — in-process (tests, React Native)

```ts
import {MemoryLink, SimulatorEngine} from 'obd2-simulator';

const link = new MemoryLink(new SimulatorEngine({seed: 7}));
link.onData((chunk) => console.log(chunk)); // '410C0EE4\r\r>'
await link.connect();
await link.write('ATZ');
await link.write('ATE0');
await link.write('010C 1'); // engine RPM, first responder only
```

Or drive the engine directly, no transport:

```ts
import {SimulatorEngine} from 'obd2-simulator';

const engine = new SimulatorEngine();
engine.handleCommand('ATE0');
engine.handleCommand('0902');   // VIN, ISO-TP framed: '014\r0:490201…'
engine.injectDtc('P0301');      // freeze frame snapshots automatically
engine.handleCommand('03');     // '43010301\r7F0310\r4300' — one line per ECU of the default car
engine.injectDtc('garbage');    // throws: invalid DTC "garbage" (expected e.g. P0301)
engine.execute('010C 1').wire;  // exact bytes incl. prompt: '410C0EE4\r\r>' (hint 1 → first responder only)
```

## Quick start — fake WiFi adapter (any OBD app)

```sh
npx obd2-simulator                                                   # the default gasoline simulator on port 35000
npx obd2-simulator --simulator default-diesel --dtc P0301
npx obd2-simulator --host 127.0.0.1 --adapter clone                  # local-only, behind a cheap clone
npx obd2-simulator --list-simulators
```

Point any OBD application (Car Scanner, Torque, your own) at `<host>:35000` as a **WiFi ELM327 adapter** and it will see a live fake vehicle. Each client connection gets its own vehicle instance. The server binds `0.0.0.0` by default (that is the point of impersonating a WiFi dongle) — pass `--host 127.0.0.1` to keep it on your machine. `Ctrl+C` shuts it down.

Programmatic (Node only, via the `obd2-simulator/node` subpath):

```ts
import {createTcpServer} from 'obd2-simulator/node';
import {SimulatorEngine} from 'obd2-simulator';

const server = createTcpServer({
    port: 35000,
    host: '127.0.0.1',
    engineFactory: () => new SimulatorEngine(),
    latencyScale: 1,                       // 0 → answer immediately
    maxLineLength: 512,                    // longer lines are discarded and answered with '?'
    onError: (error) => console.error(error.message),          // EADDRINUSE, EACCES, ...
    onClientError: (remote, error) => console.warn(remote, error.message),
});
// later: server.close()
```

## What is simulated

| Area | Detail |
|------|--------|
| Wire format | Lines end with `\r` (`\r\n` after `ATL1`), every response ends with a blank line + `>`; echo as typed until `ATE0`; spaces between bytes (`41 0C 1A F8`) until `ATS0` on hardware personas; `ATH1` prints raw CAN frames with response id + PCI byte (11-bit `7E8 …` or 29-bit `18 DA F1 10 …`) |
| AT / ST commands | `ATZ` `ATWS` `ATI` `AT@1` `AT@2` `ATD` `ATE0/1` `ATL0/1` `ATS0/1` `ATH0/1` `ATSPx` `ATSTxx` `ATAT0/1/2` `ATSHxxx` `ATCRA [xxx]` `ATPC` `ATRV` (voltage follows engine state) `ATDP` `ATDPN` `ATIGN` `ATCS` `STI` `STDI`; **unknown commands answer `?`** like real hardware |
| Protocol search | In auto mode (`ATSP0`) the first request prints `SEARCHING...` and costs the persona's search time (vLinker: 6 s); nothing answering → `UNABLE TO CONNECT`. `ATDPN` reports the vehicle's protocol (`A6` / `A7`) |
| Mode 01 | Profile-defined PID set + `0100/0120/…` support masks per ECU, batch requests (up to the adapter's `maxPids`), response-count hint, one line per responding ECU; MIL + DTC count and readiness monitors on PIDs `01`/`41` |
| Framing | Payloads over 7 bytes print in the ELM ISO-TP long form (`014` / `0:…` / `1:…`); multi-ECU responses print sequentially per ECU (or interleaved with `batch.multiFrameClean: false`) |
| Timing | Per-command latency = persona base ± jitter + the `ATST` wait window (skipped when the adapter honors a satisfied response hint, `010C 1`) + protocol search; `ATAT2` halves the window on adaptive adapters |
| Mode 02 | Freeze frame snapshotted at the moment a stored DTC appears; PID `02` answers zeros when nothing froze |
| Modes 03/07/0A + 04 | Stored / pending / permanent code lists per ECU: the engine ECU lists its codes, other ECUs answer an empty list, a negative response (`7F 03 10`) or nothing; clearing erases stored + pending + freeze frame, **permanent codes survive**; vehicles without mode 0A answer `NO DATA` |
| Mode 06 | On-board monitor test records (MID/TID/UAS/value/limits) |
| Mode 09 | `0900` mask, VIN, calibration ID, CVN, ECU name (per ECU), in-use performance counters (spark `08` / diesel `0B`) — ISO-TP framed |
| Negative responses | Any other hex request (UDS `22…`, `19…`, mode `05`) is rejected with `7F <sid> 11`; only non-hex input gets `?` |
| Driving model | Default gasoline: a recorded 15-minute real drive replayed in a loop. Others: synthetic 96s cycle (idle → acceleration → ~90 km/h cruise → deceleration). Exponential coolant/oil warm-up, fuel burn; every other signal derived from the same driving state |

## Choosing a simulator

A *simulator* is a vehicle profile together with the driving model that belongs to it, selectable by id. With no selection the default gasoline simulator runs.

```ts
import {createSimulator, listSimulators} from 'obd2-simulator';

createSimulator();                                    // 'default-gasoline'
createSimulator('default-diesel', {seed: 7});         // any SimulatorEngine option except `profile`
listSimulators().map((simulator) => simulator.id);    // ['default-gasoline', 'default-diesel']
```

| Id | Kind | Vehicle |
|----|------|---------|
| `default-gasoline` | recorded | A real 2025 spark-ignition car: engine ECU + transmission ECU + a module that rejects DTC requests, CAN 29/500, 47 PIDs, its real readiness bytes, 28 in-use counters, mode 06 results and ECU identities (only the VIN serial is synthetic), replaying a real town-and-country drive with the car's measured idle speed, operating temperature, charging voltage and fuel trim |
| `default-diesel` | synthetic | Compression-ignition car with the diesel pack (turbo, EGT, DPF, NOx, DEF) on the synthetic cycle |

`new SimulatorEngine()` without options *is* the default gasoline simulator; passing a `profile` without a `model` gives that vehicle the synthetic cycle. `getSimulator(id)` returns the definition (`profile`, `createModel()`, `kind`, `provenance`); `createSimulator` also accepts a definition of your own. Bundle-conscious apps can import one definition (`DEFAULT_DIESEL_SIMULATOR`) and pass it instead of an id, so the registry — and the recorded drive of other vehicles — can be tree-shaken.

Recorded vehicles are generated from wire logs by `npm run import-vehicle`; see [docs/ADDING-A-VEHICLE.md](./docs/ADDING-A-VEHICLE.md).

## Vehicle profiles

A vehicle is pure data — `VehicleProfile` is JSON-compatible. The profile *is* the engine ECU (`7E8`); other modules are `additionalEcus`.

```ts
import {DIESEL_PROFILE, GASOLINE_PROFILE, SimulatorEngine, dieselDrivingModel} from 'obd2-simulator';

new SimulatorEngine({profile: DIESEL_PROFILE, model: dieselDrivingModel()});

// or roll your own:
new SimulatorEngine({
    profile: {
        ...GASOLINE_PROFILE,
        vin: 'JTDKB20U903456789',
        storedDtcs: ['P0420'],
        protocol: '7',                       // ISO 15765-4 CAN 29/500 → 18DAF1xx headers, ATDPN 'A7'
        supportsPermanentDtcs: false,        // mode 0A → NO DATA
        clearRequiresEngineOff: true,        // mode 04 → 7F 04 22 while running (the recorded car does this)
        framePadding: 0xaa,                  // unused CAN frame bytes: last 'N:' segment and raw frames end in AA
        additionalEcus: [
            {id: '7E9', name: 'TCM', pids: [0x0c, 0x0d], readiness: [0x04, 0, 0], calibrationId: 'TCM-CAL-01', cvn: 'A9C9EF55'},
            {id: '7EA', pids: [], dtcReply: 'reject'}, // answers 03/07 with 7F xx 10 only
        ],
    },
});
```

| Profile | Vehicle |
|---------|---------|
| `GASOLINE_PROFILE` | The recorded car of `default-gasoline`. Pair it with `gasolineDrivingModel()` for its recorded drive — a profile passed without a `model` always gets the synthetic cycle; `createSimulator()` pairs them for you |
| `DIESEL_PROFILE` | Compression-ignition car with the diesel pack (turbo, EGT, DPF, NOx, DEF) |
| `HYBRID_PROFILE` | Gasoline hybrid: spark-ignition set + battery pack (`0x5B`), fuel type hybrid, engine off at standstill (`hybridDrivingModel()`) |
| `REFERENCE_PROFILE` | The same car as `GASOLINE_PROFILE` under its original name — kept for compatibility |

The default model takes a vehicle's measured constants and a recorded drive, which is how recorded simulators are built:

```ts
import {DefaultDrivingModel} from 'obd2-simulator';

new DefaultDrivingModel({
    traits: {idleRpm: 930, coolantTargetC: 93},              // unset traits keep their defaults
    signals: {0x0b: {base: 4, perLoadPct: 0.8, perKrpm: 4.7, perKmh: 0.7, min: 22, max: 184, noise: 3}}, // MAP fitted to recordings
    cycle: {stepSeconds: 1, speedKmh: [...], rpm: [...], throttlePct: [...], engineLoadPct: [...]},
});
```

Fully custom driving behavior is one interface away:

```ts
import type {DrivingModel} from 'obd2-simulator';

const redlineForever: DrivingModel = {
    value: (pid) => (pid === 0x0c ? 7800 : null),
};
```

## Adapter personas

The adapter in front of the vehicle is data too — `AdapterPersona` decides identity, quirks and timing. Presets were measured from real devices on the reference vehicle. The vehicle decides how many ECUs answer; the persona decides whether you see them (response hint) and how they are printed.

| Preset | Banner | Response hint | Spaces after reset | Protocol search | Latency | Notes |
|--------|--------|---------------|--------------------|-----------------|---------|-------|
| `DEFAULT_ADAPTER` | `ELM327 v1.5` | honored | off | never | 40 ms, no jitter | the ideal ELM for unit tests |
| `VLINKER_ADAPTER` | `ELM327 v2.3` | honored — only the engine ECU visible with `010C 1` | on | 6 s | 32 ± 6 ms | Vgate vLinker |
| `CLONE_V21_ADAPTER` | `OKELM327 v2.1` | **ignored** — always waits the `ATST` window, prints every ECU | on | 150 ms | 20 ± 15 ms + window, ships with `ATST FF` | cheap clone |
| `GENUINE_ELM_ADAPTER` | `ELM327 v2.2` | honored | on | 1 s | 30 ± 4 ms | reference |
| `STN_ADAPTER` | `ELM327 v1.4b` + `STI`/`STDI` | honored | on | 500 ms | 25 ± 3 ms | OBDLink |

```ts
import {CLONE_V21_ADAPTER, REFERENCE_PROFILE, SimulatorEngine} from 'obd2-simulator';

const engine = new SimulatorEngine({adapter: CLONE_V21_ADAPTER, profile: REFERENCE_PROFILE});
engine.handleCommand('ATE0');
engine.handleCommand('ATST19');
engine.execute('010C 1');
// → {command: '010C1', response: 'SEARCHING...\r41 0C 0D 19\r41 0C 0C 62', wire: '…\r\r>',
//    latency: {baseMs: 20, jitterMs: 2, waitMs: 100, searchMs: 150, totalMs: 272}}

engine.setAdapter({...CLONE_V21_ADAPTER, baseLatencyMs: 468}); // same clone, worse day
engine.linkState; // {echo, headers, spaces, linefeeds, searched, timeoutHex, adaptiveTiming, receiveFilter, requestHeader, protocol}
```

Latency model: `totalMs = base ± jitter + wait + search`, where `wait` is the `ATST` window (`hh × 4 ms`, ELM default `32` = 200 ms) unless the persona honors the response hint and the hint was met, and `search` is charged once per protocol search. A `latencyFor(command)` engine option replaces base + jitter (e.g. with a distribution from a recorded wire log). `MemoryLink` waits the modelled latency and answers strictly in order; `responseDelayMs` / `jitterMs` override base and jitter for deterministic tests (`includeWaitWindow: false` makes `responseDelayMs` the whole delay), and `link.history` records every exchange (`command`, `response`, `latencyMs`). The TCP server applies the same model (`latencyScale: 0` to disable); the CLI takes `--adapter vlinker|clone|genuine|stn`.

## Steering a scenario

Everything mutable can be driven from the test while the app keeps polling:

```ts
const engine = new SimulatorEngine();
engine.override(0x05, 120);           // coolant pinned at 120 °C (null → NO DATA); freeze frames capture it
engine.setIgnition('key-on');         // ECUs awake, engine stopped: RPM 0, 12.4 V; 'off' → every ECU asleep
engine.injectDtc('P0171', 'pending'); // pendingDtcs / permanentDtcs / removeDtc / clearDtcs
engine.failNext('BUFFER FULL', 2);    // next two OBD requests print the adapter error
engine.onCommand((result) => log(result.command, result.latency.totalMs));
const saved = engine.snapshot();      // JSON: link settings, DTCs, freeze frame, overrides, ignition, faults
engine.restore(saved);

const link = new MemoryLink(engine);
link.corruptNext('drop-prompt');      // next response arrives without '>' — exercise the timeout path
link.corruptNext('truncate');         // …or cut in half, or 'garbage' (noise bytes first)
link.simulateAdapterReset();          // banner shows up unprompted, settings back to defaults
```

### Control channel (CLI / TCP)

```sh
npx obd2-simulator --control 35001
nc 127.0.0.1 35001
dtc P0301            → ok 1 engine(s): injected P0301 (stored)
set 05 120           → ok 1 engine(s): PID 05 = 120
ignition off         → ok 1 engine(s): ignition off
fail BUFFER FULL 2   → ok 1 engine(s): next 2 request(s) → BUFFER FULL
adapter clone · clear dtcs|overrides|faults · status · help
```

Commands apply to every connected vehicle and are replayed on vehicles created later, so a scenario survives the app reconnecting. Programmatically: `createControlServer({engines})` from `obd2-simulator/node`, fed by `createTcpServer({onEngine})`; `applyControlCommand(line, engines)` is the pure core.

### Personas from your own recordings

```ts
import {latencyFromWireLog, personaFromWireLog} from 'obd2-simulator';

const rows = ndjson.map((line) => JSON.parse(line)); // {c: 'ATZ', r: '\r\rELM327 v2.3\r\r', d: 197}
const persona = personaFromWireLog(rows, {name: 'my-dongle'});         // banner, hint handling, spaces, search time, latency
const engine = new SimulatorEngine({adapter: persona, latencyFor: latencyFromWireLog(rows)}); // per-command medians
```

## Determinism

```ts
new SimulatorEngine({seed: 7, now: () => fakeClock});
```

Same seed + same clock → byte-identical output (latency jitter included). `MemoryLink` with `responseDelayMs` + `jitterMs: 0` uses fixed delays so fake timers work.

## Stability & versioning

1.0 follows semantic versioning. The exported names of `obd2-simulator` and `obd2-simulator/node`, the `VehicleProfile` / `AdapterPersona` / `EngineSnapshot` shapes, the control-channel protocol and the CLI flags only change with a major version. `tests/api-surface.test.ts` guards the exported names, the engine's public members and (at type level, via `npm run typecheck`) the fields of those three shapes. Wire output can still get *more* faithful in a minor version when a recording proves hardware behaves differently — every such change is listed in the [changelog](./CHANGELOG.md). API reference: `npm run docs` (typedoc, published to GitHub Pages on releases).

## Known limitations

- CAN only (ISO 15765-4). `ATSP1–5` are accepted but the output is still CAN-framed.
- A forced protocol that does not match the vehicle (`ATSP6` on a 29-bit car) changes the printed headers but does not fail with `NO DATA` as hardware would.
- UDS services (`22`, `19`, `10`, …) are rejected with `7F xx 11` by every addressed ECU; there is no UDS data model yet.
- In auto mode the protocol search is locked in only once an ECU answers (like hardware): probing addresses that do not exist (`ATSH`/`ATCRA` to a missing module) before the first successful request re-charges the search time each time — pin the protocol (`ATSP6`/`ATSP7`) or poll a known PID first.
- Additional ECU ids are `7E9..7EF` and map to fixed 29-bit source addresses (`0x10 + 8·n`); the `ATSH`/`ATCRA` width must match the active protocol, as on hardware.
- No transport-level fault injection yet (`BUFFER FULL`, `CAN ERROR`, dropped chunks).

## Changelog & contributing

See [CHANGELOG.md](./CHANGELOG.md), [CONTRIBUTING.md](./CONTRIBUTING.md), [ROADMAP.md](./ROADMAP.md) and [SECURITY.md](./SECURITY.md).

## License

MIT
