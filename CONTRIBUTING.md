# Contributing

Thanks for helping make the fake car more real.

## Setup

```sh
npm ci
npm run check        # lint + typecheck + tests with coverage thresholds
npm run build        # dist/ (ESM + CJS + d.ts); also enables tests/bundle.test.ts
```

Node ≥ 20 for development (vitest 4); the published package runs on Node ≥ 18, React Native and browsers.

## Ground rules

- **Zero runtime dependencies.** Dev dependencies are fine; nothing may land in `dependencies`.
- **Evidence over assumption.** Anything that claims to mimic real hardware should come with a recording: drop an anonymized `{c, r, d}` NDJSON excerpt into `tests/fixtures/wirelog/` and extend `tests/wirelog-golden.test.ts` (replace the VIN — never commit a real one).
- **Tests first.** Write the failing test, then the code. Coverage thresholds (`vitest.config.ts`) are enforced in CI.
- **Small files, pure functions.** The engine orchestrates; encoding, framing, addressing and mode 09 live in their own modules. Keep files under ~400 lines.
- **Validate at boundaries.** Profiles, personas, snapshots, CLI flags and control lines are untrusted input — fail fast with a specific message.
- **Immutable state updates.** Link state and the DTC lists are replaced, never mutated in place.
- Formatting and lint: Biome (`npm run lint`, `npm run format`). No ESLint/Prettier.

## Adding a PID

1. An encoder row in `src/core/j1979.ts` (`bytes` must match what `encode` returns — `tests/unit/j1979.test.ts` checks).
2. A signal in `src/core/DefaultDrivingModel.ts`.
3. The PID in the profiles that should advertise it.

## Adding an adapter persona

Record the device (`personaFromWireLog` gets you most of the way), then add a preset to `src/adapters/presets.ts` with a comment saying where each number came from.

## Commits and releases

Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`). Every user-visible change gets a line in `CHANGELOG.md` under the next version. Releases are tags: bump `package.json`, commit, `git tag vX.Y.Z`, push the tag — CI checks the tag against the version, then publishes with provenance.
