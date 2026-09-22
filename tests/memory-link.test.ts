import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {MemoryLink, SimulatorEngine, VLINKER_ADAPTER} from '../src/index';

const collectUntilPrompt = (link: MemoryLink): Promise<string> =>
    new Promise((resolve) => {
        let buffer = '';
        const unsubscribe = link.onData((chunk) => {
            buffer += chunk;
            if (buffer.includes('>')) {
                unsubscribe();
                resolve(buffer);
            }
        });
    });

describe('MemoryLink', () => {
    it('connects, answers with prompt framing and chunked output', async () => {
        const link = new MemoryLink(new SimulatorEngine({now: () => 0}), {
            connectDelayMs: 1,
            responseDelayMs: 1,
        });
        const statuses: string[] = [];
        link.onStatusChange((status) => statuses.push(status));

        await link.connect();
        expect(statuses).toEqual(['connecting', 'connected']);

        const pending = collectUntilPrompt(link);
        await link.write('ATZ');
        const response = await pending;
        expect(response).toBe('ATZ\r\rELM327 v1.5\r\r>');
        await link.disconnect();
    });

    it('rejects writes while disconnected', async () => {
        const link = new MemoryLink(new SimulatorEngine({now: () => 0}));
        await expect(link.write('ATZ')).rejects.toThrow('not connected');
    });
});

describe('MemoryLink timing and history', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('answers serially in command order even when latencies differ', async () => {
        const engine = new SimulatorEngine({now: () => 0});
        const link = new MemoryLink(engine, {connectDelayMs: 1, responseDelayMs: 1, jitterMs: 0});
        const connecting = link.connect();
        await vi.advanceTimersByTimeAsync(1);
        await connecting;
        const received: string[] = [];
        link.onData((chunk) => received.push(chunk));
        await link.write('ATE0');
        await link.write('010C'); // no hint → +200 ms window
        await link.write('ATRV'); // 1 ms
        await vi.advanceTimersByTimeAsync(260);
        const joined = received.join('');
        expect(joined.indexOf('410C')).toBeLessThan(joined.indexOf('V\r\r>'));
        expect(link.history.map((entry) => entry.command)).toEqual(['ATE0', '010C', 'ATRV']);
        expect(link.history[1]?.latencyMs).toBe(201);
        expect(link.history[2]?.response).toMatch(/V$/);
        await link.disconnect();
    });

    it('silences everything still queued when disconnected mid-flight', async () => {
        const link = new MemoryLink(new SimulatorEngine({now: () => 0}), {connectDelayMs: 1, responseDelayMs: 20, jitterMs: 0});
        const connecting = link.connect();
        await vi.advanceTimersByTimeAsync(1);
        await connecting;
        const received: string[] = [];
        link.onData((chunk) => received.push(chunk));
        await link.write('ATE0');
        await link.write('ATI');
        await link.write('ATI');
        await link.disconnect();
        await vi.advanceTimersByTimeAsync(120);
        expect(received).toEqual([]);
        // A fresh session answers normally.
        const reconnecting = link.connect();
        await vi.advanceTimersByTimeAsync(1);
        await reconnecting;
        const pending = collectUntilPrompt(link);
        await link.write('ATRV');
        await vi.advanceTimersByTimeAsync(25);
        expect(await pending).toMatch(/V\r\r>$/);
        await link.disconnect();
    });

    it('drops the wait window on request for fixed 0.2.0-style delays', async () => {
        const link = new MemoryLink(new SimulatorEngine({now: () => 0}), {
            connectDelayMs: 1,
            responseDelayMs: 3,
            includeWaitWindow: false,
        });
        const connecting = link.connect();
        await vi.advanceTimersByTimeAsync(1);
        await connecting;
        await link.write('ATE0');
        await link.write('010C');
        expect(link.history[1]?.latencyMs).toBe(3);
        await link.disconnect();
    });

    it('uses the persona latency when no override is given', async () => {
        const link = new MemoryLink(new SimulatorEngine({now: () => 0, adapter: VLINKER_ADAPTER}), {connectDelayMs: 1});
        const connecting = link.connect();
        await vi.advanceTimersByTimeAsync(1);
        await connecting;
        const pending = collectUntilPrompt(link);
        await link.write('ATI');
        await vi.advanceTimersByTimeAsync(100);
        await pending;
        expect(link.history[0]?.latencyMs).toBeGreaterThanOrEqual(
            VLINKER_ADAPTER.baseLatencyMs - VLINKER_ADAPTER.latencyJitterMs,
        );
        // A reset takes as long as the hardware's: about 1.2 s on the vLinker.
        const reset = collectUntilPrompt(link);
        await link.write('ATZ');
        await vi.advanceTimersByTimeAsync(1300);
        await reset;
        expect(link.history[1]?.latencyMs).toBeGreaterThan(1000);
        link.clearHistory();
        expect(link.history).toHaveLength(0);
        await link.disconnect();
    });
});
