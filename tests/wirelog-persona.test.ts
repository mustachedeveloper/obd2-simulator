import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {GENUINE_ELM_ADAPTER, SimulatorEngine, latencyFromWireLog, personaFromWireLog} from '../src/index';
import type {WireLogEntry} from '../src/index';

const fixture = (name: string): WireLogEntry[] =>
    JSON.parse(readFileSync(new URL(`./fixtures/wirelog/${name}.json`, import.meta.url), 'utf8')) as WireLogEntry[];

describe('personaFromWireLog', () => {
    it('derives identity, timing and quirks from a recording', () => {
        const persona = personaFromWireLog(fixture('vlinker-v2.3'), {name: 'recorded-vlinker'});
        expect(persona).toMatchObject({
            name: 'recorded-vlinker',
            banner: 'ELM327 v2.3',
            bannerPrefix: undefined,
            honorsResponseHint: true,
            defaultSpaces: true,
            protocolSearchMs: 6345,
        });
        // p50 of the hinted single-PID requests (≈ 28–45 ms in the log).
        expect(persona.baseLatencyMs).toBeGreaterThanOrEqual(25);
        expect(persona.baseLatencyMs).toBeLessThanOrEqual(45);
        expect(persona.latencyJitterMs).toBeGreaterThan(0);
    });

    it('spots a hint-ignoring clone with a banner prefix', () => {
        const persona = personaFromWireLog(fixture('clone-v2.1'), {name: 'recorded-clone', base: GENUINE_ELM_ADAPTER});
        expect(persona).toMatchObject({banner: 'ELM327 v2.1', bannerPrefix: 'OK', honorsResponseHint: false, protocolSearchMs: null});
        expect(persona.adaptiveTiming).toBe(GENUINE_ELM_ADAPTER.adaptiveTiming); // untouched base fields
    });

    it('leaves the hint flag to the base persona when a recording cannot prove it', () => {
        // One ECU: a single data line says nothing about hint handling.
        const singleEcu = [
            {c: 'atz', r: 'atz\r\rELM327 v1.5\r\r', d: 200},
            {c: 'ATE0', r: 'ATE0\rOK\r\r', d: 30},
            {c: '0105 1', r: '41 05 7D\r\r', d: 120},
            {c: '0105 1', r: '41 05 7D\r\r', d: 118},
        ];
        const clone = personaFromWireLog(singleEcu, {name: 'x', base: {...GENUINE_ELM_ADAPTER, honorsResponseHint: false}});
        expect(clone.honorsResponseHint).toBe(false);
        // No ATST in the recording → the wait window is unknown and not subtracted.
        expect(clone.baseLatencyMs).toBe(119);
        expect(clone.bannerPrefix).toBeUndefined(); // lowercase echo is not junk
        expect(clone.bannerBlankLine).toBe(true);
        const genuine = personaFromWireLog(singleEcu, {name: 'y', base: GENUINE_ELM_ADAPTER});
        expect(genuine.honorsResponseHint).toBe(true); // base wins when unproven
    });

    it('produces a persona the engine accepts', () => {
        const persona = personaFromWireLog(fixture('vlinker-v2.3'), {name: 'x'});
        const engine = new SimulatorEngine({adapter: persona, now: () => 0});
        expect(engine.handleCommand('ATZ')).toBe('ATZ\r\rELM327 v2.3');
    });
});

describe('latencyFromWireLog', () => {
    it('replays per-command medians and falls back for unseen commands', () => {
        const latencyFor = latencyFromWireLog(fixture('clone-v2.1'), {fallbackMs: 99});
        expect(latencyFor('ATRV')).toBe(85);
        expect(latencyFor('010C1')).toBe(118); // normalized form of '010C 1'
        expect(latencyFor('ATBOGUS')).toBe(99);
        const engine = new SimulatorEngine({now: () => 0, latencyFor});
        engine.handleCommand('ATE0');
        expect(engine.execute('ATRV').latency.baseMs).toBe(85);
    });
});
