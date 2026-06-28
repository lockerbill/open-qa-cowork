import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config.js';

/**
 * crxjs emits the content script as a loader that dynamic-imports a hashed
 * chunk, and ties that chunk's web_accessible_resources `matches` to the
 * (localhost-only) content_scripts matches. That blocks both the chunk and
 * `injected.js` from loading on any other origin the user allowlists at
 * runtime. This post-crx transform widens only the WAR `matches` to mirror
 * `optional_host_permissions`, leaving `resources` (the hashed names) and
 * `content_scripts` untouched — so code still executes only on granted origins.
 */
const WAR_MATCHES = ['https://*/*', 'http://*/*'];

function broadenWarMatches(): Plugin {
  return {
    name: 'qa-copilot:broaden-war-matches',
    enforce: 'post',
    // Rewrite on disk in writeBundle: crxjs emits manifest.json in its own
    // generateBundle, so this runs strictly after the file exists and avoids
    // any plugin-ordering / source-encoding ambiguity.
    writeBundle(options) {
      const outDir = options.dir ?? resolve(process.cwd(), 'dist');
      const manifestPath = resolve(outDir, 'manifest.json');
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (!Array.isArray(m.web_accessible_resources)) return;
      for (const war of m.web_accessible_resources) {
        war.matches = [...WAR_MATCHES];
        war.use_dynamic_url = true;
      }
      writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
    },
  };
}

export default defineConfig({
  plugins: [react(), crx({ manifest }), broadenWarMatches()],
  server: {
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
  build: {
    target: 'esnext',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
