# Roadmap

State as of 2026-09-21: the 1.0.0 work is committed on the stacked branches
`release/0.3.1` → `release/0.4.0` → `release/0.5.0` → `release/1.0.0`
(`277e476`); the selectable simulators, the recorded default gasoline
vehicle and `npm run import-vehicle` sit on top of `release/1.0.0` and are
part of 1.0.0. Nothing is pushed; npm still serves 0.2.0.

Verified on 2026-09-22: 380 tests, 96.5 % statement coverage, clean
typecheck/lint, the core bundle runs without Node globals and stays inside
its 160 KB budget (132 KB), a CLI end-to-end run (`--simulator`,
`--list-simulators`, a live TCP session) behaves as documented. Verified on
2026-08-26 and **not re-run since the default vehicle changed**:
`arethetypeswrong` + `publint`, the packed tarball under `nodenext` /
`node10` / `bundler`, the CJS and ESM entries on real Node 18, and the
control-channel end-to-end run.

## 1. Release (owner: maintainer — these cannot be automated from here)

| # | Task | Notes |
|---|------|-------|
| 1.1 | Merge and push: `git checkout main && git merge --ff-only release/1.0.0 && git push` | Brings 0.3.1 → 1.0.0 in one line of history |
| 1.2 | `git tag v1.0.0 && git push origin v1.0.0` | CI publishes to npm with provenance. **Only tag `v1.0.0`** — pushing the intermediate tags would trigger separate publishes and leave `latest` on whichever finishes last |
| 1.3 | Repository Settings → Pages → source **GitHub Actions** | One-time; `docs.yml` then publishes the typedoc API reference on every release tag |
| 1.4 | Confirm the `NPM_TOKEN` secret still works | Unused since 0.2.0 (2026-08-13). Alternative: npm trusted publishing (OIDC), which removes the token — needs the repo/workflow registered once on npmjs.com, then `NODE_AUTH_TOKEN` can go |
| 1.5 | Watch the first CI run | It has never executed: the matrix, the Node 18 smoke job, the tag ↔ version check and the publish job are all unproven on GitHub's runners |
| 1.6 | Bump AutoPulse to 1.0 and run its simulator round-trip suite | Visible differences: `ATZ` output now starts with `\r`, the prompt is `\r\r>`, PID `0x44` is 2 bytes and `0x55`/`0x56` are 1 byte. **The default gasoline vehicle is now the recorded 3-ECU CAN 29-bit car**: unhinted requests print one line per ECU, the PID set shrank to the 47 real PIDs, mode `0A` is `NO DATA`, and the drive is a recorded 15-minute loop — `SimulatorTransport` can switch to `createSimulator(id)`. PID `A4` now carries the gear alone like the car, so AutoPulse's `gearRatio` channel decodes to NaN on the default vehicle (its `simulator-roundtrip` test expects 0.5–4.5 — point it at `default-diesel` or drop it), and a hinted multi-frame request (`017A 1`) returns the first frame only on the vLinker preset. Its parsers handle all of this on the real car already, but hard-coded expectations in its tests may need updating |

## 2. Feature backlog (1.x, ordered by value)

### 2.1 UDS data model — biggest consumer win

Services `22` / `19` / `10` currently answer `7F xx 11`. AutoPulse's
`UdsClient` therefore cannot be exercised against the simulator at all.

- `VehicleProfile.uds?: {dids: Record<string, number[] | string>; sessions?: …}`
- `22 <did>` → data or `7F 22 31` (request out of range); `10 <session>` →
  `50 <session>` + timing bytes; `19 02 <status>` → DTC-by-status-mask.
- Per-ECU, like modes 03/09 already are.
- Estimate: ~1 day including golden coverage for the negative paths.

### 2.2 More recorded vehicles

The registry (`src/simulators`) and `npm run import-vehicle` exist so that
every new set of recordings becomes a selectable simulator with a ~15-line
definition (`docs/ADDING-A-VEHICLE.md`). Known gaps the recordings exposed:

- **Encoders for PIDs `65 6D 9D 9E`** — advertised by the recorded car, left
  out of its profile: no recording ever polled them, so there are no bytes
  to check an encoder against (`34 70 71 8B` were added from recorded bytes).
- **A full-sweep recording.** 16 signals are fitted from the raw
  exchanges; purge (`2E`, 16 polls), O2 sensor 2 (`15`, R² 0.19), timing
  advance, pedal position and the DPF/boost PIDs still run on generic
  formulas until a drive is recorded with every supported PID polled
  continuously next to load.
- **Adaptive timing (`ATAT1`).** On the vLinker an unhinted request returns
  after ≈ 86 ms with `ATST19` (base 31 ms + ≈ 55 % of the 100 ms window);
  the simulator waits the whole window (132 ms) by design
  (`ADAPTIVE_TIMING_FACTORS[1] = 1`). A per-persona factor would fit the
  measurement without changing the other presets. The clone presets are
  also faster than the hardware (AT commands 20 ms vs 45–70 ms measured).
- **Clone truncation as a persona trait.** The v2.1 clone cuts multi-frame
  responses off after five frames (`0908` → `01B` instead of `03B`, mode 06
  records lose their tail); today that is a documented deviation in
  `tests/wirelog-golden.test.ts`.
- **Thermostat behaviour.** With the right start temperature the coolant
  model is within 3.5 °C of the car on average; what remains is the real
  85–99 °C swing with load and airflow around a target the model holds
  flat, and oil that starts at coolant temperature on hot restarts.
- A second, single-ECU CAN 11-bit vehicle is in the data store (2026-08-23
  sessions) and would be the first test of the pipeline on another car; it
  needs recordings with VIN, mode 09 and a full drive first.

### 2.2b Wire-log recording with `ATH1` (29-bit headers) — done

`tests/fixtures/wirelog/{vlinker-fd,clone-obdii}-probe.json` hold
AutoPulse's adapter probe (`ATI AT@1 AT@2 STI ATH1 010C 1 ATH0`) and
`tests/wirelog-golden.test.ts` replays them with the header lines' address
and PCI byte unmasked.

### 2.2c The 2026-09-21 data review (110 real sessions replayed) — done on 2026-09-22

Everything the review found is in 1.0.0: the engine-off sequence
(`setIgnition('off', {afterRunMs})`), the frame-counting hint
(`hintCountsFrames`), the silent clone (`batch.overflow: 'silent'`,
`CLONE_OBDII_ADAPTER`), PID `A4` as gear (`transmissionPid`), `STOPPED`
(`MemoryLink({interruptible: true})`), the car's 29-bit source addresses and
the vLinker's trimmed raw single frames, per-persona `ATCS` / `ATIGN` /
search / reset / AT latencies and the OBDBLE voltage offset,
`VLINKER_FD_ADAPTER`, four modules on mode 04 (`clearReply`), and signal
fits from the raw exchanges (16 fits; EGT 516 °C median against a real 569,
catalyst 577 against 632, exhaust pressure and ambient within a few units).
What is left from it:

- **Thermal lag.** EGT and catalyst temperature are linear in rpm and speed
  now; the real sensors lag the drive by tens of seconds, which a first-order
  filter on the fitted value would capture. Same for coolant and oil, which
  the model holds flat at the target once warm (real 82–99 / 68–105 °C).
- **Ambient temperature** is a property of the day, not of the drive; the
  fit (35 °C at idle, falling with rpm) reproduces the sensor's heat soak
  when standing, which is real, but a `traits.ambientC` would let a test
  pick the day.
- **The clone's segment numbering** (`3:13490401…`, the second ECU's first
  frame numbered on from the first ECU's) is documented on
  `CLONE_OBDII_ADAPTER`, not modelled.
- **PID `A4` ratios.** The gear comes from a generic seven-speed table; the
  car's own ratios need more moving `A4` samples (29 exist).
- **Key-on voltage** is a guess (12.4 V); no recording has the key on with
  the engine off for long.

### 2.3 Reject a forced protocol the vehicle does not speak

`ATSP6` on a 29-bit vehicle currently only changes the printed headers; real
hardware answers `NO DATA` (or `UNABLE TO CONNECT`). Fixing this makes the
consumer's protocol-selection logic testable. Small, behind a persona or
profile flag so existing tests keep their current meaning.

### 2.4 `personaFromWireLog`: prove hint handling on single-ECU recordings

Today a single-ECU recording cannot distinguish "honors the response hint"
from "waited the whole `ATST` window", so the loader falls back to the base
persona (documented). A recording that changes `ATST` and re-polls the same
PID would show the difference in the latency distribution; the loader could
derive the flag from that instead.

### 2.5 Optional token on the control channel

Unauthenticated by design and bound to `127.0.0.1`, which is right for local
use. If anyone wants to drive the simulator across a network, a shared-secret
first line (`auth <token>`) is the minimum.

## 3. Maintenance

- **Split `SimulatorEngine.ts`** (766 lines after `vehicle-ecus.ts` moved
  out; the house limit is 800). Modes 01/02 and the DTC services can move into their own
  modules the way `mode09.ts`, `framing.ts` and `ecus.ts` already did — pure
  refactor, no behaviour change.
- **Non-CAN protocols** (`ATSP1`–`5`) are accepted but always answered with
  CAN framing. Documented as a limitation; only worth building if a consumer
  actually tests a K-line vehicle.
- Keep `CHANGELOG.md` first: any wire-output change needs a line there, even
  in a patch release — that is the contract described in the README's
  stability section.
