/**
 * Vendor smoke suite (auto-test-mode-spec §13.1). Runs the vendored
 * dom_tree/dom extraction against real layout — NOT jsdom — via the harness
 * bundle (build with `vite build -c e2e/vite.harness.config.ts`; `pnpm
 * test:e2e` chains it). The no-eval gate is the static CI grep (§4.2.1).
 */
import { test, expect, type Page } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), 'dist', 'auto-harness.js');

interface SmokeSnapshot {
  size: number;
  entries: Array<[number, string]>;
  serialized: string;
  serializedAgain: string;
  refIds: string[];
}

async function extract(page: Page): Promise<SmokeSnapshot> {
  return page.evaluate(() => {
    const { vendor } = window.__openqaHarness;
    vendor.patchReact();
    // Same wiring as the observation builder: patchReact marks roots, and the
    // marked elements join the interactive blacklist.
    const blacklist = Array.from(
      document.querySelectorAll('[data-openqa-ignore], [data-page-agent-not-interactive]'),
    );
    const tree = vendor.getFlatTree({ viewportExpansion: 400, interactiveBlacklist: blacklist });
    const map = vendor.getSelectorMap(tree);
    return {
      size: map.size,
      entries: Array.from(map, ([i, n]) => [i, n.tagName.toLowerCase()] as [number, string]),
      serialized: vendor.flatTreeToString(tree, [], false, {}),
      serializedAgain: vendor.flatTreeToString(tree, [], false, {}),
      refIds: Array.from(map.values(), (n) => n.ref.id || '(no id)'),
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/vendor-smoke.html');
  await page.addScriptTag({ path: HARNESS });
});

test('extracts the interactive elements on the fixture page', async ({ page }) => {
  const snap = await extract(page);
  // buttons, link, inputs, select, contenteditable, dialog button, react-root child
  expect(snap.size).toBeGreaterThanOrEqual(8);
  for (const id of [
    'save',
    'cancel',
    'docs-link',
    'username',
    'secret',
    'warehouse',
    'editor',
    'dialog-confirm',
    'inside-react-root',
  ]) {
    expect(snap.refIds, `expected #${id} to be indexed`).toContain(id);
  }
});

test('indices are stable within a snapshot and match the selector map', async ({ page }) => {
  const snap = await extract(page);
  expect(snap.serialized).toBe(snap.serializedAgain);
  for (const [index] of snap.entries) {
    expect(snap.serialized).toMatch(new RegExp(`\\*?\\[${index}\\]<`));
  }
});

test('excludes data-openqa-ignore, aria-hidden, and offscreen content', async ({ page }) => {
  const snap = await extract(page);
  expect(snap.refIds).not.toContain('ignored-btn');
  expect(snap.refIds).not.toContain('aria-hidden-btn');
  expect(snap.refIds).not.toContain('offscreen-btn');
  expect(snap.serialized).not.toContain('OPENQA IGNORED BUTTON');
  expect(snap.serialized).not.toContain('ARIA HIDDEN BUTTON');
  expect(snap.serialized).not.toContain('OFFSCREEN BUTTON');
});

test('patchReact keeps the react root itself non-interactive', async ({ page }) => {
  const snap = await extract(page);
  expect(snap.refIds).toContain('inside-react-root');
  expect(snap.refIds).not.toContain('root');
});

test('PageDriver.observe: redaction seam, header/footer, secret metadata', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const driver = window.__openqaHarness.createPageDriver({
      sessionId: 'smoke',
      emitRecorderEvent: () => {},
    });
    const { observation, elements } = await driver.observe();
    driver.dispose();
    return { observation, elements };
  });

  // Header/footer format (§6.2.4)
  expect(result.observation.serialized).toContain('Current Page: [Vendor Smoke Fixture]');
  expect(result.observation.serialized).toContain('Page info:');
  expect(result.observation.serialized).toContain('[Start of page]');
  // Open dialog is flagged (§6.2.5)
  expect(result.observation.activeDialog).toBe('Confirm removal');
  expect(result.observation.serialized).toContain('A dialog "Confirm removal" is open');
  // Redaction seam: page email text is tokenized, password value never leaks
  expect(result.observation.serialized).toContain('[EMAIL]');
  expect(result.observation.serialized).not.toContain('jane.doe@example.com');
  expect(result.observation.serialized).not.toContain('hunter2');
  // Secret element metadata (§5.1)
  const secret = result.elements.find((el) => el.attributes['name'] === 'password');
  expect(secret?.isSecret).toBe(true);
  expect(JSON.stringify(result.elements)).not.toContain('hunter2');
  // Fresh epoch per observation
  expect(result.observation.epoch).toBe(1);
});
