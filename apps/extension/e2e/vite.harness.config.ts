/**
 * Builds the browser-test harness (e2e/harness/entry.ts) into a single
 * self-contained IIFE that Playwright injects via addScriptTag. Output lands
 * in e2e/dist (gitignored). Run via `pnpm test:e2e` (chained) or directly:
 * `vite build -c e2e/vite.harness.config.ts`.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    lib: {
      entry: resolve(here, 'harness', 'entry.ts'),
      name: 'OpenQAHarness',
      formats: ['iife'],
      fileName: () => 'auto-harness.js',
    },
  },
});
