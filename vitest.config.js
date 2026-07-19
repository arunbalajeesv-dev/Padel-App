import { defineConfig } from 'vitest/config';

/**
 * Backend test config.
 *
 * The client is a separate package with its own vitest and its own environment
 * (it stubs Vite's `import.meta.env`). Without this exclude, a root `npm test`
 * silently swallows the client's suite — the two would share config, and a
 * client failure would report as a backend failure.
 *
 * Run the client's tests from client/ with `npm test` there.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    exclude: ['client/**', 'node_modules/**'],
  },
});
