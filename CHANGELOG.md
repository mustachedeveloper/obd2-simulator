# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (0.x: minor versions may break).

## [1.0.0] - 2026-09-23

First stable release. From here on the public API follows semantic
versioning: everything exported from `obd2-simulator` and
`obd2-simulator/node` (names guarded by `tests/api-surface.test.ts`), the
`VehicleProfile` / `AdapterPersona` / `EngineSnapshot` data shapes (their
fields are guarded at type level by the same test), the
control-channel line protocol and the CLI flags are stable; removing or
renaming any of them bumps the major version. Wire output may still change
in minor versions when a recording proves real hardware behaves differently
— that is the point of the library — and such changes are listed here.

### Changed

- **The default gasoline vehicle is now recorded from a real car.**
  `GASOLINE_PROFILE` — and therefore `new SimulatorEngine()` — is a 2025
  spark-ignition car on CAN 29/500 (`ATDPN` → `A7`, `18DAF1xx` headers) with
  an engine ECU, a transmission ECU and a module that rejects DTC requests:
  functional requests print one line per ECU (`0100` → two lines, `03` →
  `4300` / `7F0310` / `4300`), mode `0A` answers `NO DATA`, the PID set is
  the 47 PIDs the car serves (was 70 synthetic ones), readiness bytes, 28
  in-use counters, mode 06 results, calibration ids, CVNs and ECU names are
  the car's. Only the VIN serial is synthetic. `new SimulatorEngine()` also
  drives `gasolineDrivingModel()` — a recorded 15-minute drive replayed in a
  loop instead of the synthetic 96 s cycle (+~20 KB minified in the core
  bundle); a `profile` passed without a `model` keeps the synthetic cycle. Use a response
  hint (`010C 1`) or `ATCRA` for single-line answers. The idealized
  single-ECU car is gone from the public API.
- Wire output, measured against the recordings (replaying six real sessions,
  44 667 exchanges: responses with the recorded line structure went from
  56 % to 99.8 %):
  - `VehicleProfile.framePadding`: the byte ECUs fill unused CAN frame bytes
    with. The default car pads with `AA`, so the last `N:` segment of a
    multi-frame response is a whole frame (`1:100D0CAAAAAAAA`) and raw
    frames (`ATH1`) end in `AA` instead of `00`. Single frames with headers
    off are unchanged. `AdapterPersona.trimsFramePadding` hides it again;
    the v2.1 clone preset sets it, as that adapter does.
  - Mode 09 ECU names are sent in the SAE J1979 layout — a 4-byte NUL-filled
    acronym, `-`, text: `ECM-EngineControl` → `45 43 4D 00 2D …` — for every
    vehicle, as real ECUs do (was `45 43 4D 2D …`).
  - PIDs `34` (wide-band λ + pump current), `70` (boost pressure control),
    `71` (wastegate / VGT control) and `8B` (aftertreatment status) have
    encoders, checked against recorded bytes, and `65` (auxiliary I/O),
    `6D` (fuel pressure control), `9D` (engine fuel rate) and `9E` (exhaust
    flow) generic ones, so the default car advertises exactly the car's
    support masks (55 PIDs; no recording ever polled the last four).
  - PID `34`'s pump current follows λ (≈ 1.1 mA per unit of λ − 1 when
    lean, 2 mA when rich, 1.3 mA at fuel cut, as recorded: `4134FFFF814D`);
    it was a constant 0 mA.
  - The warm coolant (PIDs `05`, `67`) swings with the drive like the
    recorded car's map-controlled thermostat: ≈ 4 °C under the target after
    five minutes standing, up to 7 °C over it on the move, following the mean
    speed of the last five minutes (correlation 0.72 in 116 sessions; load
    explains nothing). Oil keeps its flat target. Catalyst, EGT and DPF
    temperatures (`3C 3E 78 79 7C`) follow the driving state averaged over
    the last 45 s instead of the instant.
  - `traits.ambientC` moves the intake temperature (`0F`, `68`) along with
    the ambient sensor; the recordings show intake air tracking the day
    (48–53 °C one day, 25–38 °C the next, same car).
  - λ PIDs (`24`, `34`, `44`) read full lean (≈ 2) during fuel cut: the
    recorded drive rolls with zero engine load. (Load, not fuel rate — in
    the recordings zero load marks 90 % of the lean readings with 1.5 %
    false alarms; the fuel-rate PID lags and marks 60 %.)
  - The default car warms up like the car: from 46 °C with τ = 160 s (median
    of its 22 recorded cold starts; was 22 °C / 150 s), oil settling 4 °C
    above coolant (`VehicleTraits.oilOverCoolantC`, default 8).
  - The vLinker preset's response hint counts CAN frames
    (`AdapterPersona.hintCountsFrames`), as the adapter does in all 179
    recorded cases: `017A 1` prints the length line and the first frame only
    (`009` / `0:417A05000A00`). Without a hint, or with a hint that covers
    the frames, nothing changes; the other presets keep counting responses.
  - PID `A4` on the default car carries the engaged gear alone, as recorded
    (`41A401000000` at standstill, `41A401200000` in second):
    `VehicleProfile.transmissionPid: 'gear'`. It used to answer `NO DATA` at
    standstill and a ratio when moving; profiles that do not declare the
    field keep the ratio layout.
  - **29-bit source addresses are the car's own**: `18DAF101` (engine) and
    `18DAF102` (transmission) instead of the `0x10 + 8·n` rule
    (`VehicleProfile.sourceAddress`, `EcuProfile.sourceAddress`, read by the
    importer from a headers-on exchange); `ATSH18DA02F1` addresses the
    transmission ECU, `ATSH18DA18F1` nobody. Profiles without the field keep
    the rule. The vLinker presets print a raw single frame only as far as
    its PCI length (`18DAF10104410C0E7E`, `trimsRawSingleFrames`).
  - Mode 04 on the default car answers from four modules — `44`, `7F0478`,
    `44`, `7F0478` (`EcuProfile.clearReply`; a module with no other role is
    `{pids: [], dtcReply: 'none', clearReply: 'pending'}`).
  - The default car's secondary signals are fitted from the raw exchanges
    (16 fits, was 9): exhaust gas temperature, catalyst temperature and
    ambient temperature follow the drive; exhaust pressure, module voltage,
    throttle B, pedal D are constants at their recorded level. The
    importer decodes the engine ECU's mode 01 answers itself and fits
    against rpm and speed alone when load was hardly ever logged next to a
    channel.
  - `ATRV` with the key off reads 12.4 V (was 12.2).
  - `ATCS` and `ATIGN` per persona (`canStatus`; both clones answer
    `ATIGN` → `ON`), `ATDPN` was already `A7`.
- `REFERENCE_PROFILE` was that same car, transcribed by hand; it is now an
  alias of `GASOLINE_PROFILE` (name `'reference'`). Two corrections come
  with it: the in-use performance record has 28 counters (`0908` → length
  line `03B`; the 12-counter `01B` was a clone adapter truncating the
  response) and the transmission calibration id reads `0CW906556EC+0562`.
- `HYBRID_PROFILE` is unchanged on the wire (it keeps its idealized base).

### Added

- `engine.setIgnition('off', {afterRunMs})` — the engine ECU's after-run
  phase, seen at the end of 62 recorded drives: it rejects every request
  with `7F xx 22` while the other ECUs are already silent (for at least
  10 s — every recording ends with the app giving up after 15 failed polls,
  so the real length is unknown), then `NO DATA` (and `UNABLE TO CONNECT`
  for a searching adapter). Control channel:
  `ignition off 12`. Without the option `'off'` is instant, as before.
- `AdapterPersona` fields measured from the recordings: `hintCountsFrames`,
  `protocolSearchFailMs` (a search nobody answers takes longer),
  `atLatencyMs`, `resetLatencyMs`, `voltageOffsetV`, `canStatus`,
  `padsSingleFrames`, `trimsRawSingleFrames`, `adaptiveTimingFactor` (the
  share of the ATST window an adapter with `ATAT1` still waits for an
  unhinted request: the vLinker presets set 0.55 — an unhinted two-ECU
  batch returns after 86 ms median with `ATST19` in 133 000 recorded
  exchanges; the default of 1, the whole window, is unchanged for the
  other presets), `batch.overflow: 'silent'`
  (a request beyond `maxPids` prints nothing — `CommandResult.silent`, the
  links stay quiet and the app runs into its timeout). Presets
  `VLINKER_FD_ADAPTER` (`vlinker-fd`) and `CLONE_OBDII_ADAPTER`
  (`clone-obdii`); the existing presets carry the measured values.
- `MemoryLink({interruptible: true})` and `engine.interrupt()`: a write
  while a command is in progress aborts it with `STOPPED`, as recorded when
  the app gives up on `SEARCHING...`; an aborted search is not locked in.
- Golden fixtures `vlinker-fd-probe` and `clone-obdii-probe`: the adapter
  probe with `ATH1`, the first recordings with 29-bit headers on.
- Selectable simulators: a `SimulatorDefinition` bundles a vehicle profile
  with its driving model. `createSimulator(id?, options?)`,
  `getSimulator(id)`, `listSimulators()`, `SIMULATORS`,
  `DEFAULT_SIMULATOR_ID`, `DEFAULT_GASOLINE_SIMULATOR`,
  `DEFAULT_DIESEL_SIMULATOR`; ids `default-gasoline` (the default) and
  `default-diesel`. CLI: `--simulator <id>`, `--list-simulators`;
  `--profile` keeps working.
- `DefaultDrivingModel` options `traits` (`VehicleTraits`: idle speed,
  operating temperature, warm-up time, charging voltage, fuel trim, intake
  temperature, oil-over-coolant offset, and where the car stands at
  power-on — `odometerKm`, `fuelLevelPct`, `warmupsSinceClear`,
  `distanceSinceClearKm` — plus `ambientC`, the day: a recorded vehicle's
  fitted ambient sensor is shifted to it, heat soak kept; the importer
  writes all five from the latest recording, so the default car starts at
  51 221 km with 79 % fuel, 84 warm-ups and 2 904 km since the last clear
  on a 30 °C day) and `cycle` (`DriveCycle`: a recorded drive replayed in a
  loop) and `signals` (`SignalFits`: per-PID fits against load, rpm and
  speed, which replace the generic formulas — the default car's manifold
  pressure, absolute load, relative throttle, fuel trims, throttle actuator,
  friction torque come from its recordings). Without them the model's
  output is unchanged, byte for byte.
  `gasolineDrivingModel()` is the default vehicle's model.
- `VehicleProfile.clearRequiresEngineOff`: mode 04 answers `7F 04 22` while
  the engine runs and clears with the key on, engine off. Off by default.
- `npm run import-vehicle` (repository only): generates a recorded
  vehicle's profile, traits and drive cycle from wire logs, with the VIN
  serial replaced and a guard against leaking recorded identifiers — see
  `docs/ADDING-A-VEHICLE.md`.
- `HYBRID_PROFILE` + `hybridDrivingModel()` (CLI `--profile hybrid`): a
  gasoline hybrid with PID `0x5B` (battery pack remaining life), fuel type
  `0x11`, and the combustion engine off at standstill.
- `PID_ENCODERS`, `encodeDtc`, `normalizeDtc` and the `PidEncoder` type are
  exported, so tests can build expected wire bytes with the simulator's own
  J1979 table.
- API reference generated with typedoc (`npm run docs`) and published to
  GitHub Pages on release tags (`.github/workflows/docs.yml`).

## [0.5.0] - 2026-08-22

Scenario release: everything a test needs to steer the fake vehicle and
adapter while the app under test is talking to it.

### Added

- Value overrides: `engine.override(pid, value | null)`, `clearOverride`,
  `clearOverrides`, `engine.overrides` — pin a PID (or make it `NO DATA`)
  without writing a driving model; freeze frames capture the pinned value.
- Ignition states: `engine.setIgnition('off' | 'key-on' | 'running')`,
  `engine.ignition`. Key off puts every ECU to sleep (`NO DATA`, or
  `SEARCHING...\rUNABLE TO CONNECT` on a searching adapter, `ATIGN OFF`,
  battery voltage); key on answers with a stopped engine (RPM/speed/load/run
  time 0, 12.4 V). `ATIGN` now watches the ignition line, not engine RPM.
- DTC API symmetry: `engine.pendingDtcs`, `engine.permanentDtcs`,
  `engine.removeDtc(code)`, `engine.clearDtcs()` (test-side reset of every
  list, unlike mode 04).
- Adapter fault injection: `engine.failNext('BUFFER FULL' | 'CAN ERROR' |
  'BUS ERROR' | 'DATA ERROR' | 'STOPPED' | 'UNABLE TO CONNECT' | 'NO DATA',
  count)`, `clearFaults`, `pendingFaults` — the next OBD requests print the
  error instead of a response (no wait window; AT commands unaffected).
- Link fault injection: `link.corruptNext('drop-prompt' | 'truncate' |
  'garbage', count)` damages the next responses on `MemoryLink`;
  `link.simulateAdapterReset()` power-cycles the adapter and prints the
  banner unprompted; `engine.resetAdapter()` underneath.
- `engine.onCommand(listener)` — every command with its `CommandResult`;
  `engine.snapshot()` / `engine.restore()` — the whole mutable state as JSON
  (link settings, DTC lists, freeze frame, overrides, ignition, faults).
- Control channel: `createControlServer({engines})` (`obd2-simulator/node`)
  and CLI `--control <port>` — a second TCP port taking `dtc P0301`, `set 05
  120`, `ignition off`, `fail BUFFER FULL 2`, `adapter clone`, `clear dtcs`,
  `status`, `help`; the CLI replays successful commands on engines created
  later so a scenario survives reconnects. `applyControlCommand(line,
  engines)` is the pure core. `createTcpServer` gained `onEngine`.
- Validation at every new boundary: `override()` rejects non-finite values
  and bad PIDs, `failNext()` / `corruptNext()` cap the queue at 1000,
  `restore()` checks the whole snapshot first and leaves the engine untouched
  when it throws.
- Tooling: Biome lint/format (`npm run lint` / `format`), `npm run check`,
  coverage thresholds (`vitest.config.ts`), CI matrix Node 20/22/24 + a Node
  18 runtime smoke, tag ↔ version check before publish, Dependabot;
  `tsconfig` with `noUncheckedIndexedAccess` / `verbatimModuleSyntax`;
  public API documented with TSDoc; unit tests for the J1979 encoders, DTC
  codec, support masks, ISO-TP framing, CAN addressing, driving model, PRNG
  and timing; a VM-sandbox test proving the core bundle needs no Node APIs;
  `CONTRIBUTING.md`, `SECURITY.md`.
- Wire-log loaders: `personaFromWireLog(entries, {name, base})` derives
  banner (+ prefix quirk), hint handling, spaces, protocol search time and
  base/jitter latency from a `{c, r, d}` recording; `latencyFromWireLog
  (entries)` replays per-command medians through `latencyFor`.

## [0.4.0] - 2026-08-22

Protocol-fidelity release, checked line by line against recordings of real
adapters (`tests/fixtures/wirelog`, replayed by `tests/wirelog-golden.test.ts`).

### Changed (breaking)

- **Wire framing.** Responses end with a blank line and the prompt exactly
  like hardware: `…\r\r>` (`ATL1` → `…\r\n\r\n>`). Previously every
  transport printed `\r\n>`. `CommandResult.wire` carries the exact bytes;
  `MemoryLink` and the TCP server emit it. `handleCommand()` / `response`
  still omit the prompt.
- **Spaces.** `ATS1`/`ATS0` now work. Hardware personas (`VLINKER_ADAPTER`,
  `CLONE_V21_ADAPTER`, `GENUINE_ELM_ADAPTER`, `STN_ADAPTER`) print spaces
  between bytes after reset (`41 0C 1A F8`, `0: 49 02 01 …`, `7E8 04 41 …`)
  until `ATS0`, as real devices do. `DEFAULT_ADAPTER` stays space-free
  (`defaultSpaces: false`).
- **Protocol search.** In auto mode (`ATSP0`, the reset default) hardware
  personas print `SEARCHING...` before the first answer and charge
  `protocolSearchMs` (vLinker 6 s, measured); a probe nobody answers prints
  `SEARCHING...\rUNABLE TO CONNECT` and searches again next time. `ATSPx`,
  `ATPC`, `ATZ`/`ATWS` reset the search. `DEFAULT_ADAPTER` never searches
  (`protocolSearchMs: null`). `CommandLatency.searchMs` is new.
- **ECUs belong to the vehicle.** `AdapterPersona.respondingEcus` /
  `secondEcuPids` are gone; `VehicleProfile.additionalEcus` (`EcuProfile`:
  id, PIDs, readiness, calibration id, CVN, name, DTC reply style) declares
  the other modules. Built-in `GASOLINE_PROFILE` / `DIESEL_PROFILE` stay
  single-ECU; the new `REFERENCE_PROFILE` (CLI `--profile reference`) is the
  two-ECU CAN 29-bit car the personas were measured on, with a third module
  that rejects DTC requests.
- Reset banner prints after a blank line (`ATZ` → `\rELM327 v1.5`); the v2.1
  clone glues `OK` in front of it (`OKELM327 v2.1`), as recorded. Echo
  repeats the command as typed (`010c 1`), not normalized.
- `CLONE_V21_ADAPTER.batch.multiFrameClean` is now `true`: every recording
  shows sequential per-ECU multi-frame output. Set it to `false` yourself to
  simulate an interleaving clone.
- PID `0x44` (commanded λ) is 2 bytes as per J1979 (was 4); PIDs `0x55` /
  `0x56` are 1 byte like single-bank vehicles (was 2).
- Requests that are valid hex but not an implemented service are rejected
  with `7F <sid> 11` (e.g. `22F190` → `7F2211`) instead of `?`; `?` is
  reserved for non-hex input, as on hardware.

### Added

- 29-bit CAN (`VehicleProfile.protocol: '7' | '9'`): `18DAF110`-style
  response headers, `ATSH 18DAxxF1` physical / `18DB33F1` functional
  addressing, `ATCRA 18DAF1xx` filters, `ATDPN` → `A7`.
- Multi-ECU modes 02/03/04/07/09: each ECU answers DTC requests with its
  list, an empty list (`4300`), a negative response (`7F 03 10`) or silence;
  mode 09 calibration id / CVN / ECU name per ECU; `0900` support mask.
- `VehicleProfile.supportsPermanentDtcs: false` → mode `0A` answers `NO DATA`.
- Freeze frame PID `02` answers `42 02 00 00 00` when no code froze a frame.
- PID `0x13` (O2 sensors present).
- `engine.wireFor(text)` for transports; `LinkState.spaces` / `linefeeds` /
  `searched`.
- Golden tests replaying anonymized vLinker and v2.1-clone recordings.

## [0.3.1] - 2026-08-22

### Fixed

- `injectDtc()`, profile DTC lists and the CLI `--dtc` flag now reject
  malformed codes (`invalid DTC "garbage" (expected e.g. P0301)`). Previously a
  typo was counted on the MIL (`0101` → MIL on, 1 code) while mode 03 printed
  an empty list. Accepted codes are normalized to upper case.
- Package types: `require()` consumers no longer see ESM declarations
  (`exports` now splits `types` per condition; `arethetypeswrong` and
  `publint` are clean). `obd2-simulator/node` resolves under legacy `node10`
  module resolution via `typesVersions`.
- The core is built once and shared as a chunk: importing both
  `obd2-simulator` and `obd2-simulator/node` no longer ships two copies of
  `SimulatorEngine` (and `instanceof` works across the two).
- TCP server: a listen failure (`EADDRINUSE`, `EACCES`) can be handled through
  the new `onError` option instead of crashing with a raw stack trace; the CLI
  prints a hint and exits 1. Client socket errors reach `onClientError`
  instead of being swallowed. A client that never sends a carriage return
  can no longer grow the input buffer without bound (`maxLineLength`, default
  512: the line is discarded and `?` printed).
- CLI: `Ctrl+C` / `SIGTERM` shut the server down cleanly; `--port` outside
  0-65535 is reported as a usage error instead of a `RangeError` from
  `net.Server.listen`.
- `createTcpServer()` validates `port`, `latencyScale` and `maxLineLength` up
  front (a `maxLineLength` of 0 used to answer every command with `?`).

### Added

- CLI `--host <address>` to choose the bind interface (default `0.0.0.0`,
  use `127.0.0.1` for local-only).
- `package.json` `repository` / `homepage` / `bugs` metadata.

### Changed

- Dev tooling: vitest 4, `@vitest/coverage-v8` (`npm run test:coverage`),
  `@types/node` pinned to the oldest supported major line for type checks.

## [0.3.0] - 2026-08-22

### Added

- Adapter personas (`AdapterPersona`) with presets measured from real
  devices: `DEFAULT_ADAPTER`, `VLINKER_ADAPTER`, `CLONE_V21_ADAPTER`,
  `GENUINE_ELM_ADAPTER`, `STN_ADAPTER`; `engine.setAdapter()` mid-session.
- AT/ST command table: unknown commands answer `?`; new `ATI`, `AT@1/@2`,
  `STI`/`STDI`, `ATIGN`, `ATCS`, `ATDP`, `ATH0/1`, `ATCRA [hhh]`, `ATAT0/1/2`,
  `ATSTxx`, `ATSH`, `ATD`/`ATWS`.
- Latency model: base ± jitter + `ATST` window, skipped when the adapter
  honors a satisfied response-count hint; `ATAT2` halves the window;
  `engine.execute()` returns response + latency; `latencyFor()` hook.
- Multi-ECU mode 01 (second ECU serves its PID subset), `ATH1` raw CAN frames
  with PCI byte, `ATCRA` filter, `ATSH` physical addressing.
- Batch limits (`maxPids`, unsupported → `NO DATA`), ISO-TP long form for
  payloads over 7 bytes, interleaved segments on dirty clones.
- `MemoryLink`: strictly ordered responses, command history, queued responses
  silenced on disconnect; `jitterMs` / `includeWaitWindow` options.
- TCP server applies the latency model (`latencyScale`); CLI `--adapter`.

### Changed

- `MemoryLink` with `responseDelayMs` now adds the `ATST` wait window on top;
  pass `includeWaitWindow: false` for the 0.2.0 behaviour.

## [0.2.0] - 2026-08-13

### Added

- 87 new PIDs across the gasoline and diesel profiles, including J1979-DA
  packet PIDs (MAF/coolant/IAT sensor packs, EGR pack, turbo, exhaust
  pressure, EGT banks, DPF, NOx, DEF level, gear ratio, odometer).
- Driving model: distance integral feeding odometer and distance-since-clear,
  run-time and warm-up counters, per-signal behaviours.

## [0.1.0] - 2026-08-12

### Added

- Initial release: ELM327/OBD-II vehicle simulator with `SimulatorEngine`,
  in-process `MemoryLink`, Node TCP server and CLI; modes 01/02/03/04/06/07/
  09/0A, gasoline and diesel profiles, deterministic seeded output.

[1.0.0]: https://github.com/mustachedeveloper/obd2-simulator/compare/v0.5.0...v1.0.0
[0.5.0]: https://github.com/mustachedeveloper/obd2-simulator/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mustachedeveloper/obd2-simulator/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/mustachedeveloper/obd2-simulator/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/mustachedeveloper/obd2-simulator/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mustachedeveloper/obd2-simulator/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mustachedeveloper/obd2-simulator/releases/tag/v0.1.0
