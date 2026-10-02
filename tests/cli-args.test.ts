import {describe, expect, it} from 'vitest';
import {getSimulator} from '../src/index';
import {USAGE, parseArgs} from '../src/node/cli-args';

const simulatorOf = (argv: readonly string[]) => {
    const result = parseArgs(argv);
    if (result.kind !== 'run') throw new Error(`expected a run, got ${JSON.stringify(result)}`);
    return result.options.simulator;
};

describe('CLI argument parsing', () => {
    it('applies the documented defaults', () => {
        expect(parseArgs([])).toEqual({
            kind: 'run',
            options: {
                port: 35000,
                host: '0.0.0.0',
                simulator: getSimulator('default-gasoline'),
                adapter: 'default',
                dtcs: [],
                seed: 42,
                control: null,
            },
        });
    });

    it('accepts every option, repeatable --dtc included', () => {
        const result = parseArgs([
            '-p',
            '4000',
            '--host',
            '127.0.0.1',
            '--simulator',
            'default-diesel',
            '--adapter',
            'clone',
            '--dtc',
            'p0301',
            '--dtc',
            'P0420',
            '--seed',
            '7',
            '--control',
            '4001',
        ]);
        expect(result).toEqual({
            kind: 'run',
            options: {
                port: 4000,
                host: '127.0.0.1',
                simulator: getSimulator('default-diesel'),
                adapter: 'clone',
                dtcs: ['P0301', 'P0420'],
                seed: 7,
                control: 4001,
            },
        });
    });

    it('asks for help on --help / -h', () => {
        expect(parseArgs(['--help'])).toEqual({kind: 'help'});
        expect(parseArgs(['-h'])).toEqual({kind: 'help'});
    });

    it('selects a simulator by id', () => {
        expect(simulatorOf(['--simulator', 'default-diesel'])).toBe(getSimulator('default-diesel'));
        expect(simulatorOf(['--simulator', 'default-gasoline'])).toBe(getSimulator('default-gasoline'));
    });

    it('no longer knows the pre-1.0 --profile spelling', () => {
        expect(parseArgs(['--profile', 'gasoline'])).toEqual({kind: 'error', message: 'unknown option "--profile"'});
    });

    it('lists the simulators on --list-simulators', () => {
        expect(parseArgs(['--list-simulators'])).toEqual({kind: 'list-simulators'});
        expect(USAGE).toContain('--simulator <id>');
        expect(USAGE).toContain('default-gasoline | default-diesel');
    });

    it('reports malformed values with a specific message', () => {
        expect(parseArgs(['--dtc', 'garbage'])).toEqual({kind: 'error', message: 'invalid DTC "garbage" (expected e.g. P0301)'});
        expect(parseArgs(['--port', 'abc'])).toMatchObject({kind: 'error', message: expect.stringContaining('--port')});
        expect(parseArgs(['--port', '99999'])).toMatchObject({kind: 'error', message: expect.stringContaining('0-65535')});
        expect(parseArgs(['--port', '-1'])).toMatchObject({kind: 'error', message: expect.stringContaining('0-65535')});
        expect(parseArgs(['--simulator', 'tesla'])).toEqual({
            kind: 'error',
            message: '--simulator expects default-gasoline | default-diesel, got "tesla"',
        });
        expect(parseArgs(['--simulator'])).toMatchObject({kind: 'error', message: expect.stringContaining('--simulator')});
        expect(parseArgs(['--adapter', 'nope'])).toMatchObject({kind: 'error', message: expect.stringContaining('--adapter')});
        expect(parseArgs(['--seed'])).toMatchObject({kind: 'error', message: expect.stringContaining('--seed')});
        expect(parseArgs(['--bogus'])).toMatchObject({kind: 'error', message: expect.stringContaining('--bogus')});
    });
});
