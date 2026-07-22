import { defineManifest } from '@crxjs/vite-plugin';

/**
 * MV3 manifest (spec §15). Minimum-viable permissions; no broad `<all_urls>`.
 * The static content script targets localhost (dev + the E2E fixture). Other
 * origins are added at runtime through the options page, which requests an
 * optional host permission and registers the content script for that origin.
 */
export default defineManifest({
  manifest_version: 3,
  name: 'QA Copilot',
  version: '0.1.8',
  description: 'AI pair-tester for manual QA: analyze pages, record flows, generate tests & bug reports.',
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  action: {
    default_title: 'Open QA Copilot',
    default_icon: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  },
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  side_panel: { default_path: 'src/sidepanel/index.html' },
  options_page: 'src/options/index.html',
  content_scripts: [
    {
      matches: ['http://localhost/*', 'http://127.0.0.1/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
      all_frames: false,
    },
  ],
  permissions: ['activeTab', 'scripting', 'sidePanel', 'storage', 'tabs', 'desktopCapture', 'tabCapture'],
  host_permissions: ['http://localhost/*', 'http://127.0.0.1/*'],
  // optional_host_permissions is valid MV3 but missing from crxjs's types.
  ...({ optional_host_permissions: ['https://*/*', 'http://*/*'] } as Record<string, unknown>),
  // NOTE: the final WAR `matches` are broadened to the optional origins
  // (https://*/* + http://*/*) by the `broadenWarMatches` plugin in
  // vite.config.ts — these localhost-only matches are not the built output.
  // crxjs also auto-adds the hashed content-script chunk to this list at build.
  web_accessible_resources: [
    {
      resources: ['injected.js'],
      matches: ['http://localhost/*', 'http://127.0.0.1/*'],
    },
  ],
});
