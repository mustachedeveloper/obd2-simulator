import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createContext, runInContext} from 'node:vm';
import {describe, expect, it} from 'vitest';

// The core claims to run in React Native and browsers: the built bundle must
// not touch Node APIs. Runs the CJS build inside a bare VM context that
// offers nothing but timers and Math — no process, Buffer or net, and a
// `require` that only follows the bundle's own relative chunks. Needs
// `npm run build` first (CI runs it after the build; locally it skips).

const BUNDLE = fileURLToPath(new URL('../dist/index.cjs', import.meta.url));

interface CjsModule {
    exports: Record<string, unknown>;
}

// Minimal CommonJS loader confined to dist/: relative specifiers only.
function loadInSandbox(entry: string): Record<string, unknown> {
    const cache = new Map<string, CjsModule>();
    const sandbox = {setTimeout, clearTimeout, Math, Date, console};
    const context = createContext(sandbox);
    const load = (file: string): Record<string, unknown> => {
        const cached = cache.get(file);
        if (cached) return cached.exports;
        const module: CjsModule = {exports: {}};
        cache.set(file, module);
        const source = readFileSync(file, 'utf8');
        expect(source, file).not.toMatch(/require\(["']node:/);
        expect(source, file).not.toMatch(/\bprocess\./);
        const wrapper = runInContext(`(function (module, exports, require) {${source}\n})`, context, {filename: file}) as (
            m: CjsModule,
            e: Record<string, unknown>,
            r: (spec: string) => unknown,
        ) => void;
        wrapper(module, module.exports, (spec: string) => {
            if (!spec.startsWith('.')) throw new Error(`bundle tried to require "${spec}"`);
            return load(resolve(dirname(file), spec));
        });
        return module.exports;
    };
    return load(entry);
}

// Everything a React Native / browser app downloads for `obd2-simulator`:
// the entry plus the chunks it shares with the node entry. The default
// vehicle's recorded drive (~20 KB minified) is part of it on purpose — a
// bare `new SimulatorEngine()` replays it. The budget keeps that, and every
// vehicle added later, from growing unnoticed.
const CORE_BUDGET_BYTES = 160 * 1024;

describe.skipIf(!existsSync(BUNDLE))('built core bundle', () => {
    it('stays within its size budget', () => {
        const dist = dirname(BUNDLE);
        const bytes = readdirSync(dist)
            .filter((file) => file.endsWith('.js'))
            .reduce((sum, file) => sum + statSync(resolve(dist, file)).size, 0);
        expect(bytes).toBeLessThan(CORE_BUDGET_BYTES);
    });

    it('loads and simulates a vehicle with no Node globals at all', () => {
        const api = loadInSandbox(BUNDLE) as {
            SimulatorEngine: new (options: object) => {handleCommand(c: string): string};
            MemoryLink: new (engine: object) => {connect(): Promise<void>};
        };
        const engine = new api.SimulatorEngine({now: () => 0});
        expect(engine.handleCommand('ATE0')).toBe('ATE0\rOK');
        // The default vehicle has two ECUs that report engine speed.
        expect(engine.handleCommand('010C')).toMatch(/^410C[0-9A-F]{4}\r410C[0-9A-F]{4}$/);
        expect(typeof api.MemoryLink).toBe('function');
    });
});
