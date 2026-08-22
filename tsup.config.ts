import {defineConfig} from 'tsup';

// One build for every entry so the core is emitted once and shared as a
// chunk: importing both 'obd2-simulator' and 'obd2-simulator/node' yields a
// single SimulatorEngine class (instanceof works, no doubled bundle). The
// CLI keeps its shebang from the source file.
export default defineConfig({
    entry: {
        index: 'src/index.ts',
        'node/index': 'src/node/index.ts',
        'node/cli': 'src/node/cli.ts',
    },
    format: ['esm', 'cjs'],
    splitting: true,
    dts: {entry: {index: 'src/index.ts', 'node/index': 'src/node/index.ts'}},
    sourcemap: true,
    clean: true,
    target: 'es2020',
});
