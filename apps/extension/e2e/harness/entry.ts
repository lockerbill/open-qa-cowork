/**
 * Browser-test harness entry (auto-test-mode-spec §13.1–13.2). Bundled by
 * e2e/vite.harness.config.ts into a chrome-free IIFE that Playwright injects
 * into fixture pages, so the vendor smoke suite and the M1 acceptance run
 * against real layout (dom_tree.js needs it — jsdom cannot).
 *
 * Vendor imports are allowed here: this is test scaffolding outside `src`
 * (the lint boundary protects production code paths).
 */
import { createRecorder } from '../../src/content/recorder.js';
import { createPageDriver } from '../../src/content/auto/page-driver.js';
import { flatTreeToString, getFlatTree, getSelectorMap } from '../../src/vendor/page-agent/dom.js';
import { patchReact } from '../../src/vendor/page-agent/patches/react.js';

declare global {
  interface Window {
    __openqaHarness: {
      createRecorder: typeof createRecorder;
      createPageDriver: typeof createPageDriver;
      vendor: {
        getFlatTree: typeof getFlatTree;
        getSelectorMap: typeof getSelectorMap;
        flatTreeToString: typeof flatTreeToString;
        patchReact: typeof patchReact;
      };
    };
  }
}

window.__openqaHarness = {
  createRecorder,
  createPageDriver,
  vendor: { getFlatTree, getSelectorMap, flatTreeToString, patchReact },
};
