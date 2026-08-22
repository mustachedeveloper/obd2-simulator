import type {LinkStatus} from '../core/types';
import {SimulatorEngine} from '../core/SimulatorEngine';

// In-process link: the simulator behaving like a connected serial adapter.
// Platform-agnostic (works in React Native, Node and browsers) — timers are
// the only environment API used. Emits responses with the same '\r\n>'
// prompt framing as real ELM327 hardware, split into chunks so consumers
// exercise their buffer-until-prompt logic on every run. Commands are
// answered strictly in order: a slow response (ATST window) delays the
// ones queued behind it, like a real single-threaded adapter.

export interface MemoryLinkOptions {
    connectDelayMs?: number;
    // Fixed base latency replacing the persona's baseLatencyMs.
    responseDelayMs?: number;
    // Replaces the persona's jitter (0 → deterministic delays).
    jitterMs?: number;
    // false → ignore the ATST wait window, so responseDelayMs (+ jitter) is
    // the whole delay, as in 0.2.0. Default true.
    includeWaitWindow?: boolean;
    // Responses longer than this are emitted in two chunks.
    chunkSplitThreshold?: number;
    // Oldest history entries are dropped beyond this many.
    historyLimit?: number;
}

// One exchange as the link saw it; `at` is the wall-clock write time.
export interface CommandLogEntry {
    command: string;
    response: string;
    latencyMs: number;
    at: number;
}

const DEFAULT_CONNECT_DELAY_MS = 150;
const DEFAULT_CHUNK_SPLIT_THRESHOLD = 6;
const DEFAULT_HISTORY_LIMIT = 500;

export class MemoryLink {
    private readonly engine: SimulatorEngine;
    private readonly connectDelayMs: number;
    private readonly responseDelayMs: number | null;
    private readonly jitterMs: number | null;
    private readonly includeWaitWindow: boolean;
    private readonly chunkSplitThreshold: number;
    private readonly historyLimit: number;
    private readonly dataListeners = new Set<(chunk: string) => void>();
    private readonly statusListeners = new Set<(status: LinkStatus) => void>();
    private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();
    // Rejection handles for promise-backed delays. disconnect() must REJECT
    // these, not just clear their timers — a cleared timer would leave an
    // in-flight connect() or queued response pending forever.
    private readonly pendingDelayRejects = new Set<(error: Error) => void>();
    private status: LinkStatus = 'disconnected';
    private log: CommandLogEntry[] = [];
    // Serialization point for responses: each write chains behind the last.
    private tail: Promise<void> = Promise.resolve();
    // Bumped on disconnect so responses still queued behind an in-flight
    // delay notice they belong to a dead session and never emit.
    private session = 0;

    constructor(engine: SimulatorEngine, options: MemoryLinkOptions = {}) {
        this.engine = engine;
        this.connectDelayMs = options.connectDelayMs ?? DEFAULT_CONNECT_DELAY_MS;
        this.responseDelayMs = options.responseDelayMs ?? null;
        this.jitterMs = options.jitterMs ?? null;
        this.includeWaitWindow = options.includeWaitWindow ?? true;
        this.chunkSplitThreshold = options.chunkSplitThreshold ?? DEFAULT_CHUNK_SPLIT_THRESHOLD;
        this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    }

    get currentEngine(): SimulatorEngine {
        return this.engine;
    }

    // Every exchange since connect (or clearHistory), oldest first.
    get history(): readonly CommandLogEntry[] {
        return this.log;
    }

    clearHistory(): void {
        this.log = [];
    }

    async connect(): Promise<void> {
        if (this.status === 'connected') return;
        this.setStatus('connecting');
        await this.delay(this.connectDelayMs);
        this.setStatus('connected');
    }

    async disconnect(): Promise<void> {
        for (const timer of this.pendingTimers) clearTimeout(timer);
        this.pendingTimers.clear();
        for (const reject of this.pendingDelayRejects) reject(new Error('simulator disconnected'));
        this.pendingDelayRejects.clear();
        this.session += 1;
        this.tail = Promise.resolve();
        this.setStatus('disconnected');
    }

    async write(data: string): Promise<void> {
        if (this.status !== 'connected') {
            throw new Error('simulator not connected');
        }
        const result = this.engine.execute(data);
        const latencyMs = Math.max(
            0,
            (this.responseDelayMs ?? result.latency.baseMs) +
                (this.jitterMs ?? result.latency.jitterMs) +
                (this.includeWaitWindow ? result.latency.waitMs : 0),
        );
        this.record({command: result.command, response: result.response, latencyMs, at: Date.now()});
        const response = `${result.response}\r\n>`;
        const session = this.session;
        this.tail = this.tail.then(
            async () => {
                if (session !== this.session) return;
                await this.delay(latencyMs);
                if (session !== this.session) return;
                this.emit(response);
            },
            // A disconnect rejected the previous link; the session check
            // above keeps anything queued behind it silent.
            () => undefined,
        );
        this.tail.catch(() => undefined);
    }

    onData(cb: (chunk: string) => void): () => void {
        this.dataListeners.add(cb);
        return () => this.dataListeners.delete(cb);
    }

    onStatusChange(cb: (status: LinkStatus) => void): () => void {
        this.statusListeners.add(cb);
        return () => this.statusListeners.delete(cb);
    }

    private record(entry: CommandLogEntry): void {
        const next = [...this.log, entry];
        this.log = next.length > this.historyLimit ? next.slice(next.length - this.historyLimit) : next;
    }

    private emit(response: string): void {
        const chunks =
            response.length > this.chunkSplitThreshold
                ? [response.slice(0, this.chunkSplitThreshold), response.slice(this.chunkSplitThreshold)]
                : [response];
        for (const chunk of chunks) {
            for (const listener of this.dataListeners) listener(chunk);
        }
    }

    private setStatus(status: LinkStatus): void {
        if (this.status === status) return;
        this.status = status;
        for (const listener of this.statusListeners) listener(status);
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingTimers.delete(timer);
                this.pendingDelayRejects.delete(reject);
                resolve();
            }, ms);
            this.pendingTimers.add(timer);
            this.pendingDelayRejects.add(reject);
        });
    }
}
