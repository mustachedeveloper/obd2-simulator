# Roadmap

State as of 2026-08-26: the 1.0.0 work is committed on the stacked branches
`release/0.3.1` → `release/0.4.0` → `release/0.5.0` → `release/1.0.0`
(`277e476`). Nothing is pushed; npm still serves 0.2.0.

Verified before release: 212 tests, 95.5 % statement coverage, clean
typecheck/lint, `arethetypeswrong` + `publint` clean, the packed tarball
installs and resolves types under `nodenext` / `node10` / `bundler`, the CJS
and ESM entries run on real Node 18, and a CLI + control-channel end-to-end
run behaves as documented.

## 1. Release (owner: maintainer — these cannot be automated from here)

| # | Task | Notes |
|---|------|-------|
| 1.1 | Merge and push: `git checkout main && git merge --ff-only release/1.0.0 && git push` | Brings 0.3.1 → 1.0.0 in one line of history |
| 1.2 | `git tag v1.0.0 && git push origin v1.0.0` | CI publishes to npm with provenance. **Only tag `v1.0.0`** — pushing the intermediate tags would trigger separate publishes and leave `latest` on whichever finishes last |
| 1.3 | Repository Settings → Pages → source **GitHub Actions** | One-time; `docs.yml` then publishes the typedoc API reference on every release tag |
| 1.4 | Confirm the `NPM_TOKEN` secret still works | Unused since 0.2.0 (2026-08-13). Alternative: npm trusted publishing (OIDC), which removes the token — needs the repo/workflow registered once on npmjs.com, then `NODE_AUTH_TOKEN` can go |
| 1.5 | Watch the first CI run | It has never executed: the matrix, the Node 18 smoke job, the tag ↔ version check and the publish job are all unproven on GitHub's runners |
| 1.6 | Bump AutoPulse to 1.0 and run its simulator round-trip suite | Visible differences: `ATZ` output now starts with `\r`, the prompt is `\r\r>`, PID `0x44` is 2 bytes and `0x55`/`0x56` are 1 byte. Its parsers tolerate all of these, but hard-coded expectations in its tests may need updating |

## 2. Feature backlog (1.x, ordered by value)

### 2.1 UDS data model — biggest consumer win

Services `22` / `19` / `10` currently answer `7F xx 11`. AutoPulse's
`UdsClient` therefore cannot be exercised against the simulator at all.

- `VehicleProfile.uds?: {dids: Record<string, number[] | string>; sessions?: …}`
- `22 <did>` → data or `7F 22 31` (request out of range); `10 <session>` →
  `50 <session>` + timing bytes; `19 02 <status>` → DTC-by-status-mask.
- Per-ECU, like modes 03/09 already are.
- Estimate: ~1 day including golden coverage for the negative paths.

### 2.2 Wire-log recording with `ATH1` (29-bit headers)

`18DAF1xx` header framing is only asserted synthetically
(`tests/fidelity.test.ts`); neither fixture recording ever enables headers,
so `tests/wirelog-golden.test.ts` cannot catch a byte-order regression there.
Needs one recording session on the reference car with `ATH1` in the init
sequence, then a new fixture + golden case.

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

- **Split `SimulatorEngine.ts`** (~700 lines after the TSDoc pass; the house
  limit is 800). Modes 01/02 and the DTC services can move into their own
  modules the way `mode09.ts`, `framing.ts` and `ecus.ts` already did — pure
  refactor, no behaviour change.
- **Non-CAN protocols** (`ATSP1`–`5`) are accepted but always answered with
  CAN framing. Documented as a limitation; only worth building if a consumer
  actually tests a K-line vehicle.
- Keep `CHANGELOG.md` first: any wire-output change needs a line there, even
  in a patch release — that is the contract described in the README's
  stability section.
