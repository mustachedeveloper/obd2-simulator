import type {AdapterPersona} from '../core/types';
import {GENUINE_ELM_ADAPTER} from './presets';

// Personas and latency models derived from a recording of a real adapter:
// one `{c, r, d}` row per exchange (command, raw response text, round-trip
// milliseconds) — the format AutoPulse's wire logger writes. Pure functions:
// parse the NDJSON yourself, hand over the rows.

export interface WireLogEntry {
    c: string;
    r: string;
    d: number;
}

export interface PersonaFromWireLogOptions {
    name: string;
    // Fields the recording cannot reveal are copied from here.
    base?: AdapterPersona;
}

export interface LatencyFromWireLogOptions {
    // Latency for commands the recording never issued.
    fallbackMs?: number;
}

const BANNER = /(ELM327 v[0-9][0-9A-Za-z.]*)/;
const HINTED_SINGLE_PID = /^01[0-9A-F]{2}1$/;
// A positive response line of any OBD service (41..4A), headers or not.
const DATA_LINE = /^(?:[0-9A-F]{3}|[0-9A-F]{8})?4[1-9A]/;
const OBD_REQUEST = /^0[1-9A]/;
const TIMEOUT_UNIT_MS = 4;
const DEFAULT_FALLBACK_MS = 50;

const normalize = (command: string): string => command.replace(/\s+/g, '').toUpperCase();
const lines = (text: string): string[] => text.split(/\r\n?|\n/).map((line) => line.trim()).filter(Boolean);

function median(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

// Banner text, whatever junk precedes it on its line, and whether a blank
// line came first. The echo (as typed, any case) is not junk.
function bannerOf(entries: readonly WireLogEntry[]): {banner: string; prefix: string | undefined; blankLine: boolean} | null {
    for (const entry of entries) {
        const command = normalize(entry.c);
        if (command !== 'ATZ' && command !== 'ATWS' && command !== 'ATI') continue;
        const raw = entry.r.split(/\r\n?|\n/).map((line) => line.trim());
        const withoutEcho = raw.filter((line) => normalize(line) !== command);
        const index = withoutEcho.findIndex((line) => BANNER.test(line));
        if (index < 0) continue;
        const line = withoutEcho[index];
        const match = BANNER.exec(line)!;
        const prefix = line.slice(0, match.index);
        return {banner: match[1], prefix: prefix.length > 0 ? prefix : undefined, blankLine: index > 0 && withoutEcho[index - 1] === ''};
    }
    return null;
}

const dataLines = (text: string): number => lines(text).filter((line) => DATA_LINE.test(line)).length;

// A hinted single-PID request that still printed two data lines means the
// adapter ignores the hint. Honoring it can only be proven on a multi-ECU
// bus: some unhinted request showed several ECUs, a hinted one showed one.
// A single-ECU recording proves nothing → null (the base persona decides).
function honorsHint(entries: readonly WireLogEntry[]): boolean | null {
    let hintedSingle = false;
    let multiEcu = false;
    for (const entry of entries) {
        const command = normalize(entry.c);
        if (HINTED_SINGLE_PID.test(command)) {
            if (dataLines(entry.r) >= 2) return false;
            hintedSingle = true;
        } else if (OBD_REQUEST.test(command) && dataLines(entry.r) >= 2) multiEcu = true;
    }
    return hintedSingle && multiEcu ? true : null;
}

// Spaces between bytes in any OBD response printed before ATS0 was sent.
function spacesBeforeAts0(entries: readonly WireLogEntry[]): boolean | null {
    for (const entry of entries) {
        const command = normalize(entry.c);
        if (command === 'ATS0') return null;
        if (command === 'ATS1') return true;
        if (!OBD_REQUEST.test(command)) continue;
        const data = lines(entry.r).find((line) => DATA_LINE.test(line));
        if (data) return / /.test(data);
    }
    return null;
}

// ATST window set during the recording (hex × 4 ms); 0 when the recording
// never set one (unknown, so nothing is subtracted from the measurements).
function waitWindowMs(entries: readonly WireLogEntry[]): number {
    const set = entries.map((entry) => /^ATST([0-9A-F]{2})$/.exec(normalize(entry.c))).find(Boolean);
    return set ? Number.parseInt(set[1], 16) * TIMEOUT_UNIT_MS : 0;
}

export function personaFromWireLog(entries: readonly WireLogEntry[], options: PersonaFromWireLogOptions): AdapterPersona {
    const base = options.base ?? GENUINE_ELM_ADAPTER;
    const banner = bannerOf(entries);
    const hint = honorsHint(entries) ?? base.honorsResponseHint;
    const search = entries.find((entry) => /SEARCHING/.test(entry.r));
    const hinted = entries.filter((entry) => HINTED_SINGLE_PID.test(normalize(entry.c)) && !/SEARCHING/.test(entry.r)).map((entry) => entry.d);
    const measured = median(hinted);
    // A hint-ignoring adapter sat through the ATST window on every one of
    // those requests; the persona models that window separately.
    const window = hint ? 0 : waitWindowMs(entries);
    const baseLatencyMs = measured === null ? base.baseLatencyMs : Math.max(1, measured - window);
    const deviations = measured === null ? [] : hinted.map((d) => Math.abs(d - measured));
    const jitter = median(deviations);
    return {
        ...base,
        name: options.name,
        banner: banner?.banner ?? base.banner,
        bannerPrefix: banner?.prefix,
        bannerBlankLine: banner ? banner.blankLine : base.bannerBlankLine,
        honorsResponseHint: hint,
        defaultSpaces: spacesBeforeAts0(entries) ?? base.defaultSpaces,
        protocolSearchMs: search ? search.d : null,
        baseLatencyMs,
        latencyJitterMs: jitter === null ? base.latencyJitterMs : Math.max(1, jitter),
    };
}

// Per-command median round-trip from the recording, keyed by the engine's
// normalized command form — plug into SimulatorEngineOptions.latencyFor.
export function latencyFromWireLog(entries: readonly WireLogEntry[], options: LatencyFromWireLogOptions = {}): (command: string) => number {
    const samples = new Map<string, number[]>();
    for (const entry of entries) {
        const key = normalize(entry.c);
        samples.set(key, [...(samples.get(key) ?? []), entry.d]);
    }
    const medians = new Map([...samples].map(([key, values]) => [key, median(values) ?? 0]));
    const fallback = options.fallbackMs ?? DEFAULT_FALLBACK_MS;
    return (command) => medians.get(normalize(command)) ?? fallback;
}
