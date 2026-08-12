# obd2-simulator

A zero-dependency **ELM327 / OBD-II vehicle simulator** — a fake car for testing diagnostic apps.

Feed it the exact ASCII commands a real ELM327 adapter receives; get back the exact text a real adapter prints, including echo behavior, `>` prompt framing, ISO-TP multi-frame responses and supported-PID masks. Your parsers, schedulers and UI run their **real code paths** against it.

- **Zero runtime dependencies.** Pure TypeScript core, ~small bundle, no native modules.
- **Runs anywhere.** React Native (Hermes), Node ≥ 18, browsers.
- **Deterministic.** Seeded PRNG + injectable clock: same seed, same output — no flaky tests.
- **A whole vehicle, not just RPM.** Live data with a driving cycle, fault-code lifecycle, freeze frame, monitor tests, readiness, VIN & vehicle info.

## Install

```sh
npm install obd2-simulator
```

## Quick start — in-process (tests, React Native)

```ts
import {MemoryLink, SimulatorEngine} from 'obd2-simulator';

const link = new MemoryLink(new SimulatorEngine({seed: 7}));
link.onData((chunk) => console.log(chunk)); // '41 0C ...\r\n>'
await link.connect();
await link.write('ATZ');
await link.write('010C'); // engine RPM
```

Or drive the engine directly, no transport:

```ts
import {SimulatorEngine} from 'obd2-simulator';

const engine = new SimulatorEngine();
engine.handleCommand('ATE0');
engine.handleCommand('0902');   // VIN, ISO-TP framed
engine.injectDtc('P0301');      // freeze frame snapshots automatically
engine.handleCommand('03');     // '43010301'
```

## Quick start — fake WiFi adapter (any OBD app)

```sh
npx obd2-simulator --port 35000 --profile diesel --dtc P0301
```

Point any OBD application (Car Scanner, Torque, your own) at `<host>:35000` as a **WiFi ELM327 adapter** and it will see a live fake vehicle. Each client connection gets its own vehicle instance.

Programmatic (Node only, via the `obd2-simulator/node` subpath):

```ts
import {createTcpServer} from 'obd2-simulator/node';
import {SimulatorEngine} from 'obd2-simulator';

createTcpServer({port: 35000, engineFactory: () => new SimulatorEngine()});
```

## What is simulated

| Area | Detail |
|------|--------|
| AT handshake | `ATZ` `ATE0/1` `ATRV` (voltage follows engine state) `ATDPN`, echo semantics |
| Mode 01 | Profile-defined PID set + `0100/0120/…` support masks, batch requests, response-count hint; MIL + DTC count and readiness monitors on PIDs `01`/`41` |
| Mode 02 | Freeze frame snapshotted at the moment a stored DTC appears |
| Modes 03/07/0A + 04 | Stored / pending / permanent code lists; clearing erases stored + pending + freeze frame, **permanent codes survive** — like real hardware |
| Mode 06 | On-board monitor test records (MID/TID/UAS/value/limits) |
| Mode 09 | VIN, calibration ID, CVN, ECU name, in-use performance counters (spark `08` / diesel `0B`) — ISO-TP framed |
| Driving model | 96s cycle: idle → acceleration → ~90 km/h cruise → deceleration; exponential coolant/oil warm-up, gear-aware RPM, fuel burn |

## Vehicle profiles

A vehicle is pure data — `VehicleProfile` is JSON-compatible:

```ts
import {DIESEL_PROFILE, GASOLINE_PROFILE, SimulatorEngine, dieselDrivingModel} from 'obd2-simulator';

new SimulatorEngine({profile: DIESEL_PROFILE, model: dieselDrivingModel()});

// or roll your own:
new SimulatorEngine({
    profile: {
        ...GASOLINE_PROFILE,
        vin: 'JTDKB20U903456789',
        storedDtcs: ['P0420'],
    },
});
```

Custom driving behavior is one interface away:

```ts
import type {DrivingModel} from 'obd2-simulator';

const redlineForever: DrivingModel = {
    value: (pid) => (pid === 0x0c ? 7800 : null),
};
```

## Determinism

```ts
new SimulatorEngine({seed: 7, now: () => fakeClock});
```

Same seed + same clock → byte-identical output. `MemoryLink` uses fixed, configurable delays so fake timers work.

## License

MIT
