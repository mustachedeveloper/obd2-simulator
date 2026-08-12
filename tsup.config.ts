import {defineConfig} from 'tsup';

export default defineConfig([
    {
        entry: {index: 'src/index.ts'},
        format: ['esm', 'cjs'],
        dts: true,
        sourcemap: true,
        clean: true,
    },
    {
        entry: {'node/index': 'src/node/index.ts'},
        format: ['esm', 'cjs'],
        dts: true,
        sourcemap: true,
    },
    {
        entry: {'node/cli': 'src/node/cli.ts'},
        format: ['esm'],
        banner: {js: '#!/usr/bin/env node'},
    },
]);
