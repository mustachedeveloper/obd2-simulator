import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';

// One recording session of the AutoPulse wire logger: gzip NDJSON, one
// record per line — 'h' header, 'x' adapter exchange, 's' decoded sample,
// 'e' app event, 'z' terminator. Only what the importer needs is kept.

export interface Exchange {
    /**
     * Epoch milliseconds.
     */
    t: number;
    c: string;
    r: string;
}

export interface Sample {
    t: number;
    /**
     * Channel id ('rpm', 'speed', 'coolant', ...).
     */
    p: string;
    v: number;
}

export interface Session {
    file: string;
    startedAt: number;
    adapter: string;
    exchanges: readonly Exchange[];
    samples: readonly Sample[];
    /**
     * Strings that identify the device, the app install or the session and
     * must never reach generated output.
     */
    secrets: readonly string[];
    badLines: number;
}

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function parseLine(line: string): Row | null {
    try {
        const parsed: unknown = JSON.parse(line);
        return isRow(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function headerSecrets(header: Row): string[] {
    const dev = isRow(header.dev) ? header.dev : {};
    const device = isRow(header.device) ? header.device : {};
    return [text(header.sid), text(dev.id), text(device.installId)].filter((secret) => secret.length > 0);
}

/**
 * @throws if the file cannot be read or is not gzip.
 */
export function readSession(file: string): Session {
    const rows = gunzipSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map(parseLine);
    const valid = rows.filter((row): row is Row => row !== null);
    const header = valid.find((row) => row.k === 'h') ?? {};
    const dev = isRow(header.dev) ? header.dev : {};
    return {
        file,
        startedAt: typeof header.t === 'number' ? header.t : 0,
        adapter: text(dev.name),
        exchanges: valid
            .filter((row) => row.k === 'x' && typeof row.c === 'string' && typeof row.r === 'string')
            .map((row) => ({t: Number(row.t) || 0, c: text(row.c), r: text(row.r)})),
        samples: valid
            .filter((row) => row.k === 's' && typeof row.p === 'string' && typeof row.v === 'number' && Number.isFinite(row.v))
            .map((row) => ({t: Number(row.t) || 0, p: text(row.p), v: row.v as number})),
        secrets: headerSecrets(header),
        badLines: rows.length - valid.length,
    };
}
