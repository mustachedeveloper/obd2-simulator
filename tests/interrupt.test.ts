import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {MemoryLink, VLINKER_ADAPTER, createSimulator} from '../src/index';

// Recorded on the vLinker with the ignition off: the app gives up on
// 'SEARCHING...' after 3 s and sends the next command; its bytes abort the
// search and the adapter prints STOPPED instead of executing it.

const calm = {...VLINKER_ADAPTER, latencyJitterMs: 0};

async function linked(options: ConstructorParameters<typeof MemoryLink>[1] = {}) {
    const engine = createSimulator('default-gasoline', {now: () => 0, seed: 7, adapter: calm});
    const link = new MemoryLink(engine, {connectDelayMs: 0, chunkSplitThreshold: 1000, ...options});
    const chunks: string[] = [];
    link.onData((chunk) => chunks.push(chunk));
    const connecting = link.connect();
    await vi.advanceTimersByTimeAsync(1);
    await connecting;
    for (const command of ['ATE0', 'ATS0', 'ATST19', 'ATSP0']) {
        await link.write(command);
        await vi.advanceTimersByTimeAsync(100);
    }
    chunks.length = 0;
    return {engine, link, chunks};
}

describe('MemoryLink — interruptible', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('prints SEARCHING... at once, and STOPPED when the next command cuts the search short', async () => {
        const {engine, link, chunks} = await linked({interruptible: true});
        engine.setIgnition('off');
        await link.write('010D 1');
        await vi.advanceTimersByTimeAsync(3000);
        expect(chunks.join('')).toBe('SEARCHING...\r');
        await link.write('0105 1');
        await vi.advanceTimersByTimeAsync(700);
        expect(chunks.join('')).toBe('SEARCHING...\rSTOPPED\r\r>');
        expect(link.history.slice(-2).map((entry) => entry.response)).toEqual(['SEARCHING...', 'STOPPED']);
        // Nothing else arrives: the aborted answer is gone, 0105 was never run.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(chunks.join('')).toBe('SEARCHING...\rSTOPPED\r\r>');
    });

    it('does not lock the protocol in when a successful search is aborted', async () => {
        const {link, chunks} = await linked({interruptible: true});
        await link.write('0100');
        await vi.advanceTimersByTimeAsync(1000);
        await link.write('ATRV');
        await vi.advanceTimersByTimeAsync(700);
        expect(chunks.join('')).toBe('SEARCHING...\rSTOPPED\r\r>');
        chunks.length = 0;
        await link.write('0100');
        await vi.advanceTimersByTimeAsync(7000);
        expect(chunks.join('')).toMatch(/^SEARCHING\.\.\.\r4100BE3EA813\r4100981A0001\r\r>$/);
    });

    it('aborts an ordinary request the same way, quickly', async () => {
        const {link, chunks} = await linked({interruptible: true});
        await link.write('0100');
        await vi.advanceTimersByTimeAsync(7000);
        chunks.length = 0;
        await link.write('010C'); // 32 ms + the 100 ms window
        await vi.advanceTimersByTimeAsync(50);
        await link.write('010D');
        await vi.advanceTimersByTimeAsync(40);
        expect(chunks.join('')).toBe('STOPPED\r\r>');
        await link.write('010D');
        await vi.advanceTimersByTimeAsync(200);
        expect(chunks.join('')).toMatch(/^STOPPED\r\r>410D/);
    });

    it('lets a finished command be followed at once', async () => {
        const {link, chunks} = await linked({interruptible: true});
        await link.write('ATI');
        await vi.advanceTimersByTimeAsync(32);
        await link.write('ATI');
        await vi.advanceTimersByTimeAsync(32);
        expect(chunks.join('')).toBe('ELM327 v2.3\r\r>ELM327 v2.3\r\r>');
    });

    it('queues as before without the option, search time not included', async () => {
        const {link, chunks} = await linked();
        await link.write('0100');
        await link.write('ATI');
        await vi.advanceTimersByTimeAsync(300);
        expect(chunks.join('')).toMatch(/^SEARCHING\.\.\.\r4100[0-9A-F\r]+\r>ELM327 v2\.3\r\r>$/);
    });
});
