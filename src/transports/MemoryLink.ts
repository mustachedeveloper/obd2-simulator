import type {LinkStatus} from '../core/types';
import {SimulatorEngine} from '../core/SimulatorEngine';

// In-process link: the simulator behaving like a connected serial adapter.
// Platform-agnostic (works in React Native, Node and browsers) — timers are
// the only environment API used. Emits responses with the same '\r\n>'
// prompt framing as real ELM327 hardware, split into chunks so consumers
// exercise their buffer-until-prompt logic on every run.

export interface MemoryLinkOptions {
    connectDelayMs?: number;
    responseDelayMs?: number;
    // Responses longer than this are emitted in two chunks.
    chunkSplitThreshold?: number;
}

const DEFAULT_CONNECT_DELAY_MS = 150;
const DEFAULT_RESPONSE_DELAY_MS = 40;
const DEFAULT_CHUNK_SPLIT_THRESHOLD = 6;

export class MemoryLink {
    private readonly engine: SimulatorEngine;
    private readonly connectDelayMs: number;
    private readonly responseDelayMs: number;
    private readonly chunkSplitThreshold: number;
    private readonly dataListeners = new Set<(chunk: string) => void>();
    private readonly statusListeners = new Set<(status: LinkStatus) => void>();
    private readonly pendingTimers = new Set<ReturnType<typeof setTimeout>>();
    // Rejection handles for promise-backed delays (connect). disconnect()
    // must REJECT these, not just clear their timers — a cleared timer would
    // leave an in-flight connect() pending forever.
    private readonly pendingDelayRejects = new Set<(error: Error) => void>();
    private status: LinkStatus = 'disconnected';

    constructor(engine: SimulatorEngine, options: MemoryLinkOptions = {}) {
        this.engine = engine;
        this.connectDelayMs = options.connectDelayMs ?? DEFAULT_CONNECT_DELAY_MS;
        this.responseDelayMs = options.responseDelayMs ?? DEFAULT_RESPONSE_DELAY_MS;
        this.chunkSplitThreshold = options.chunkSplitThreshold ?? DEFAULT_CHUNK_SPLIT_THRESHOLD;
    }

    get currentEngine(): SimulatorEngine {
        return this.engine;
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
        this.setStatus('disconnected');
    }

    async write(data: string): Promise<void> {
        if (this.status !== 'connected') {
            throw new Error('simulator not connected');
        }
        const response = `${this.engine.handleCommand(data)}\r\n>`;
        const timer = setTimeout(() => {
            this.pendingTimers.delete(timer);
            this.emit(response);
        }, this.responseDelayMs);
        this.pendingTimers.add(timer);
    }

    onData(cb: (chunk: string) => void): () => void {
        this.dataListeners.add(cb);
        return () => this.dataListeners.delete(cb);
    }

    onStatusChange(cb: (status: LinkStatus) => void): () => void {
        this.statusListeners.add(cb);
        return () => this.statusListeners.delete(cb);
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
