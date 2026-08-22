import {defineConfig} from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            // The CLI entry is process glue (argv, exit codes, signals); its
            // parsing lives in cli-args.ts and is unit-tested there.
            exclude: ['src/node/cli.ts', 'src/index.ts', 'src/node/index.ts'],
            thresholds: {statements: 90, branches: 85, functions: 90, lines: 90},
        },
    },
});
