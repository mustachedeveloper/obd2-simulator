import {describe, expect, it} from 'vitest';
import {MemoryLink, SimulatorEngine} from '../src/index';

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
        expect(response).toBe('ATZ\rELM327 v1.5\r\n>');
        await link.disconnect();
    });

    it('rejects writes while disconnected', async () => {
        const link = new MemoryLink(new SimulatorEngine({now: () => 0}));
        await expect(link.write('ATZ')).rejects.toThrow('not connected');
    });
});
