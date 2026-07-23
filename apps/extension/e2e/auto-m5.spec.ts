/**
 * M5 acceptance (auto-test-mode-spec §14): a complete demo run driven through
 * the REAL Auto tab UI (setup → run → result) with the deterministic stub
 * decider — producing a defect card that one-click-opens the bug-report
 * generator prefilled, and a Playwright draft that replays green against the
 * fixture. Hermetic: no LLM, no app server.
 */
import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { buildPlaywrightSpec } from '@qa-copilot/shared';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distPath = join(extensionRoot, 'dist');
const FIXTURE = 'http://localhost:5555/auto-playground.html';
const STUB_DECIDER = 'http://127.0.0.1:5557';

let context: BrowserContext;
let worker: Worker;
let panel: Page;
let fixturePage: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  });
  let [sw] = context.serviceWorkers();
  sw ??= await context.waitForEvent('serviceworker');
  worker = sw;
});

test.afterAll(async () => {
  await context?.close();
});

test('M5 demo: panel-driven setup → run → result with a defect card', async () => {
  test.setTimeout(90_000);

  // Target page first, then the side panel page; the run targets the ACTIVE
  // tab, so the fixture is brought back to front before Start.
  fixturePage = await context.newPage();
  await fixturePage.goto(FIXTURE);
  const extensionId = new URL(worker.url()).host;
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
  await fixturePage.bringToFront();

  // Setup view (§10): goal, origin allowlist, decider override, Start.
  await panel.getByRole('button', { name: 'Auto' }).click();
  await panel.getByPlaceholder('e.g. Log in and create an item').fill('scenario:broken_endpoint');
  await panel.getByPlaceholder('https://staging.example.com').fill('http://localhost:5555');
  await panel.getByPlaceholder('defaults to backend URL').fill(STUB_DECIDER);
  const start = panel.getByRole('button', { name: 'Start run' });
  await expect(start).toBeEnabled();
  await start.click();

  // Result view (§10): outcome banner, red defect card, assertion summary,
  // metrics chips, and the run timeline.
  const defectCard = panel.locator('.defect-card');
  await expect(defectCard.first()).toBeVisible({ timeout: 45_000 });
  await expect(defectCard.first()).toContainText('Load data fails with a server error');
  await expect(panel.locator('.auto-result .chip').first()).toContainText('fail');
  await expect(panel.locator('.auto-result')).toContainText('Steps:');
  await expect(panel.locator('.auto-result')).toContainText('LLM calls:');
  await expect(panel.locator('.auto-trace li').first()).toBeVisible();
});

test('M5 acceptance: the defect card one-click-opens the bug-report generator prefilled (§11)', async () => {
  await panel.locator('.defect-card').getByRole('button', { name: 'Generate bug report' }).click();

  // The existing Generate tab opens with the note seeded from the defect.
  await expect(panel.getByRole('button', { name: 'Generate bug report' }).first()).toBeVisible();
  const note = panel.getByPlaceholder(/Expected behavior \/ note/);
  await expect(note).toHaveValue(/Defect: Load data fails with a server error/);
  await expect(note).toHaveValue(/Expected: data loads successfully/);

  // §11: auto-sourced events show the ⚙ badge in the session timeline.
  await panel.getByRole('button', { name: /^Session/ }).click();
  await expect(panel.locator('.timeline .chip', { hasText: '⚙' }).first()).toBeVisible();
});

test('M5 acceptance: the Playwright draft replays green against the fixture (spec 14)', async () => {
  test.setTimeout(120_000);

  // The run's recorder session feeds the existing deterministic generator.
  const { session } = (await worker.evaluate(() => chrome.storage.local.get('session'))) as {
    session: Parameters<typeof buildPlaywrightSpec>[0];
  };
  const spec = buildPlaywrightSpec(session);
  // §11: the model's stated intent rides the draft as a comment.
  expect(spec.content).toContain('// intent: load the data');

  // Replay the draft in a nested Playwright run against the live fixture.
  // NOT under test-results/ — Playwright never collects specs from there.
  const replayDir = join(extensionRoot, '.m5-replay');
  rmSync(replayDir, { recursive: true, force: true });
  mkdirSync(replayDir, { recursive: true });
  writeFileSync(join(replayDir, spec.filename), spec.content);
  writeFileSync(
    join(replayDir, 'playwright.config.ts'),
    "import { defineConfig } from '@playwright/test';\n" +
      "export default defineConfig({ testDir: '.', timeout: 30_000 });\n",
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(PW_|PLAYWRIGHT|TEST_WORKER|TEST_PARALLEL)/.test(key),
    ),
  ) as NodeJS.ProcessEnv;
  // No shell: node + the Playwright CLI entry, args passed as an array.
  const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
  let output = '';
  try {
    output = execFileSync(
      process.execPath,
      [cli, 'test', `--config=${join(replayDir, 'playwright.config.ts')}`],
      { cwd: extensionRoot, env, encoding: 'utf8' },
    );
  } catch (err) {
    const e = err as { message: string; stdout?: string; stderr?: string };
    throw new Error(`replay run failed: ${e.message}\n--- stdout ---\n${e.stdout ?? ''}\n--- stderr ---\n${e.stderr ?? ''}`);
  } finally {
    rmSync(replayDir, { recursive: true, force: true });
  }
  expect(output).toMatch(/1 passed/);
});
