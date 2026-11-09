import { defineConfig } from 'vitest/config';

// Two projects: the server side (CommonJS, Node) and the browser player
// (ES modules under src/, run in jsdom). Coverage spans both.
export default defineConfig({
  test: {
    pool: 'forks',
    // Each test file gets its own process, so module-level state in the
    // CommonJS files (db.js keeps one client, watchTracking keeps caches)
    // never leaks from one file into the next.
    isolate: true,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    testTimeout: 15000,
    hookTimeout: 60000,
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          environment: 'node',
          include: ['tests/server/**/*.test.{js,mjs}', 'tests/_infra/**/*.test.{js,mjs}'],
          setupFiles: ['tests/setup/node.js'],
          globalSetup: ['tests/setup/mongo-global.js'],
        },
      },
      {
        extends: true,
        test: {
          name: 'player',
          environment: 'jsdom',
          include: ['tests/player/**/*.test.{js,mjs}'],
          setupFiles: ['tests/setup/jsdom.js'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['*.js', '*.cjs', 'src/**/*.js'],
      exclude: ['eslint.config.js', 'webpack.config.js', 'vitest.config.mjs', 'dist/**', 'scripts/**', 'tests/**'],
      reporter: ['text-summary', 'text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      thresholds: {
        lines: 75,
        statements: 75,
      },
    },
  },
});
