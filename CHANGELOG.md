# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) (0.x: minor versions may break).

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

[0.5.0]: https://github.com/mustachedeveloper/obd2-simulator/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mustachedeveloper/obd2-simulator/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/mustachedeveloper/obd2-simulator/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/mustachedeveloper/obd2-simulator/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mustachedeveloper/obd2-simulator/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mustachedeveloper/obd2-simulator/releases/tag/v0.1.0
