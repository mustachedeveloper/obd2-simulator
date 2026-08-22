import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {CLONE_V21_ADAPTER, REFERENCE_PROFILE, SimulatorEngine, VLINKER_ADAPTER} from '../src/index';
import type {AdapterPersona} from '../src/index';

// Golden tests against recordings of real adapters on the reference vehicle
// (two-ECU Škoda, ISO 15765-4 CAN 29/500): the same command sequence must
// produce the same *shape* — line count, line prefixes, payload lengths,
// SEARCHING / NO DATA / negative-response lines — with data bytes masked,
// since the simulated vehicle is not the recorded one. The VIN in the
// fixtures is already replaced by the simulator's.
//
// Coverage gap: neither recording sends ATH1, so 29-bit header framing
// (18DAF1xx) is only asserted synthetically in fidelity.test.ts.

interface WireLogEntry {
    c: string;
    r: string;
    d: number;
}

const fixture = (name: string): WireLogEntry[] =>
    JSON.parse(readFileSync(new URL(`./fixtures/wirelog/${name}.json`, import.meta.url), 'utf8')) as WireLogEntry[];

const HEX_LINE = /^[0-9A-F]+$/;
const SEGMENT_LINE = /^([0-9A-F]):([0-9A-F]+)$/;
const VOLTAGE_LINE = /^\d+\.\dV$/;
const KEEP_PREFIX = 4;

// '4100BE3EA813' → '4100XXXXXXXX', '1:5A5A5A314B5A42' → '1:XXXXXXXXXXXXXX'.
function maskLine(line: string): string {
    if (VOLTAGE_LINE.test(line)) return '<voltage>';
    const segment = SEGMENT_LINE.exec(line);
    if (segment) return `${segment[1]}:${'X'.repeat((segment[2] ?? '').length)}`;
    if (HEX_LINE.test(line) && line.length > KEEP_PREFIX)
        return line.slice(0, KEEP_PREFIX) + 'X'.repeat(line.length - KEEP_PREFIX);
    return line;
}

// Content lines only: the recordings keep inconsistent trailing CR/LF and
// sometimes the echo, which the app's logger stripped unevenly.
const shape = (text: string, command: string): string[] =>
    text
        .split(/\r\n?|\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && line !== command)
        .map(maskLine);

// Vehicle quirks the simulator deliberately does not reproduce.
const KNOWN_DEVIATIONS: Readonly<Record<string, string>> = {
    // The engine ECU pads its 27-byte in-use performance record with a fifth,
    // all-zero consecutive frame; the simulator sends exactly the payload.
    '0908': 'extra zero-padding frame',
};

function replay(name: string, adapter: AdapterPersona): void {
    const entries = fixture(name);
    const engine = new SimulatorEngine({now: () => 60_000, seed: 7, adapter, profile: REFERENCE_PROFILE});
    for (const entry of entries) {
        const simulated = engine.execute(entry.c);
        if (entry.c in KNOWN_DEVIATIONS) {
            expect(shape(simulated.response, entry.c)[0], `${name}: ${entry.c} length line`).toBe(shape(entry.r, entry.c)[0]);
            continue;
        }
        expect(shape(simulated.response, entry.c), `${name}: ${entry.c}`).toEqual(shape(entry.r, entry.c));
    }
}

describe('wire-log golden replay', () => {
    it('matches the vLinker (ELM327 v2.3) recording shape for shape', () => {
        replay('vlinker-v2.3', VLINKER_ADAPTER);
    });

    it('matches the v2.1 clone recording shape for shape', () => {
        replay('clone-v2.1', CLONE_V21_ADAPTER);
    });

    it('charges a multi-second protocol search on the vLinker like the recording', () => {
        const search = fixture('vlinker-v2.3').find((entry) => entry.r.startsWith('SEARCHING'));
        expect(search).toBeDefined();
        const engine = new SimulatorEngine({now: () => 60_000, seed: 7, adapter: VLINKER_ADAPTER, profile: REFERENCE_PROFILE});
        for (const command of ['ATZ', 'ATE0', 'ATS0', 'ATSP0']) engine.handleCommand(command);
        const {latency} = engine.execute(search!.c);
        expect(latency.searchMs).toBeGreaterThan(1000);
        expect(latency.totalMs).toBeGreaterThan(search!.d * 0.5);
    });
});
