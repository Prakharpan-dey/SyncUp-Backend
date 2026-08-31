import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Runs before any test file, and therefore before anything imports
    // src/core/config/env.ts — which parses process.env at module load.
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // Each file gets a fresh module registry, so the module-level `db` and
    // `redis` singletons cannot leak mocked state between files.
    isolate: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Generated, trivial, or entirely I/O — nothing a unit test can assert.
      exclude: ['src/core/db/schema/**', 'src/main.ts', 'src/**/*.d.ts'],
    },
  },
});
