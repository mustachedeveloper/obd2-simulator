# Security

## Scope

obd2-simulator is a development and test tool. It has no runtime dependencies and never talks to a real vehicle; the only network surface is the optional Node TCP server (`obd2-simulator/node`, the CLI) that impersonates a WiFi ELM327 adapter, plus its optional control channel.

Things to know when running it:

- The fake adapter binds `0.0.0.0` by default so phones on the same network can reach it — that is the feature. Use `--host 127.0.0.1` when you only need local clients.
- The control channel (`--control`) defaults to `127.0.0.1` and is unauthenticated by design: anyone who can reach it can steer the simulated vehicles. Do not expose it beyond your machine.
- Input lines are capped (`maxLineLength`, 512 bytes for the adapter, 256 for the control channel); fault queues are capped at 1000 entries; snapshots are validated before being applied.

## Reporting

Please report vulnerabilities privately to mh.emreyildiz@gmail.com rather than opening a public issue. You will get an acknowledgement within a few days; fixes ship as a patch release with a CHANGELOG entry.
