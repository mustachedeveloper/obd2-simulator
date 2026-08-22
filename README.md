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
| AT / ST commands | `ATZ` `ATWS` `ATI` `AT@1` `AT@2` `ATD` `ATE0/1` `ATL0/1` `ATS0/1` `ATH0/1` `ATSPx` `ATSTxx` `ATAT0/1/2` `ATSHxxx` `ATCRA [xxx]` `ATRV` (voltage follows engine state) `ATDP` `ATDPN` `ATIGN` `ATCS` `STI` `STDI`; **unknown commands answer `?`** like real hardware |
| Mode 01 | Profile-defined PID set + `0100/0120/…` support masks, batch requests (up to the adapter's `maxPids`), response-count hint, one line per responding ECU; MIL + DTC count and readiness monitors on PIDs `01`/`41` |
| Framing | Payloads over 7 bytes print in the ELM ISO-TP long form (`00A` / `0:…` / `1:…`); `ATH1` prints raw CAN frames with response id + PCI byte; dirty clones interleave two ECUs' segments |
| Timing | Per-command latency = persona base ± jitter + the `ATST` wait window, skipped when the adapter honors a satisfied response hint (`010C 1`); `ATAT2` halves the window on adaptive adapters |
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

## Adapter personas

The adapter in front of the vehicle is data too — `AdapterPersona` decides identity, quirks and timing. Presets were measured from real devices on a two-ECU car:

| Preset | Banner | Response hint | ECUs | Batch | Notes |
|--------|--------|---------------|------|-------|-------|
| `DEFAULT_ADAPTER` | `ELM327 v1.5` | honored | 1 | 6 PIDs, clean | pre-0.3.0 behaviour, no jitter |
| `VLINKER_ADAPTER` | `ELM327 v2.3` | honored | 2 (`7E8`, `7E9`) — only `7E8` visible with `010C 1` | 6 PIDs, clean | Vgate vLinker; 32 ms |
| `CLONE_V21_ADAPTER` | `ELM327 v2.1` | **ignored** — always waits the `ATST` window | 2, second ECU serves 14 PIDs | multi-frame segments interleave | cheap clone; 20 ms + window, ships with `ATST FF` |
| `GENUINE_ELM_ADAPTER` | `ELM327 v2.2` | honored | 1 | 6 PIDs, clean | reference |
| `STN_ADAPTER` | `ELM327 v1.4b` + `STI`/`STDI` | honored | 1 | 6 PIDs, clean | OBDLink |

```ts
import {CLONE_V21_ADAPTER, MemoryLink, SimulatorEngine} from 'obd2-simulator';

const engine = new SimulatorEngine({adapter: CLONE_V21_ADAPTER});
engine.handleCommand('ATST19');
engine.execute('010C 1');
// → {command: '010C1', response: '410C0E80\r410C0E84', latency: {baseMs: 20, jitterMs: 3, waitMs: 100, totalMs: 123}}

engine.setAdapter({...CLONE_V21_ADAPTER, baseLatencyMs: 468}); // same clone, worse day
engine.linkState; // {echo, headers, timeoutHex, adaptiveTiming, receiveFilter, requestHeader, protocol}
```

Latency model: `totalMs = base ± jitter + wait`, where `wait` is the `ATST` window (`hh × 4 ms`, ELM default `32` = 200 ms) unless the persona honors the response hint and the hint was met. A `latencyFor(command)` engine option replaces base + jitter (e.g. with a distribution from a recorded wire log). `MemoryLink` waits the modelled latency and answers strictly in order; `responseDelayMs` / `jitterMs` override base and jitter for deterministic tests (note: since 0.3.0 the wait window is added on top — pass `includeWaitWindow: false` to make `responseDelayMs` the whole delay as before), and `link.history` records every exchange (`command`, `response`, `latencyMs`). The TCP server applies the same model (`latencyScale: 0` to disable); the CLI takes `--adapter vlinker|clone|genuine|stn`.

## Determinism

```ts
new SimulatorEngine({seed: 7, now: () => fakeClock});
```

Same seed + same clock → byte-identical output (latency jitter included). `MemoryLink` with `responseDelayMs` + `jitterMs: 0` uses fixed delays so fake timers work.

## License

MIT
