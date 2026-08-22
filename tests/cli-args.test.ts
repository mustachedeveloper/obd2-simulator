import {describe, expect, it} from 'vitest';
import {parseArgs} from '../src/node/cli-args';

describe('CLI argument parsing', () => {
    it('applies the documented defaults', () => {
        expect(parseArgs([])).toEqual({
            kind: 'run',
            options: {port: 35000, host: '0.0.0.0', profile: 'gasoline', adapter: 'default', dtcs: [], seed: 42},
        });
    });

    it('accepts every option, repeatable --dtc included', () => {
        const result = parseArgs(['-p', '4000', '--host', '127.0.0.1', '--profile', 'diesel', '--adapter', 'clone', '--dtc', 'p0301', '--dtc', 'P0420', '--seed', '7']);
        expect(result).toEqual({
            kind: 'run',
            options: {port: 4000, host: '127.0.0.1', profile: 'diesel', adapter: 'clone', dtcs: ['P0301', 'P0420'], seed: 7},
        });
    });

    it('asks for help on --help / -h', () => {
        expect(parseArgs(['--help'])).toEqual({kind: 'help'});
        expect(parseArgs(['-h'])).toEqual({kind: 'help'});
    });

    it('reports malformed values with a specific message', () => {
        expect(parseArgs(['--dtc', 'garbage'])).toEqual({kind: 'error', message: 'invalid DTC "garbage" (expected e.g. P0301)'});
        expect(parseArgs(['--port', 'abc'])).toMatchObject({kind: 'error', message: expect.stringContaining('--port')});
        expect(parseArgs(['--port', '99999'])).toMatchObject({kind: 'error', message: expect.stringContaining('0-65535')});
        expect(parseArgs(['--port', '-1'])).toMatchObject({kind: 'error', message: expect.stringContaining('0-65535')});
        expect(parseArgs(['--profile', 'lpg'])).toMatchObject({kind: 'error', message: expect.stringContaining('--profile')});
        expect(parseArgs(['--adapter', 'nope'])).toMatchObject({kind: 'error', message: expect.stringContaining('--adapter')});
        expect(parseArgs(['--seed'])).toMatchObject({kind: 'error', message: expect.stringContaining('--seed')});
        expect(parseArgs(['--bogus'])).toMatchObject({kind: 'error', message: expect.stringContaining('--bogus')});
    });
});
