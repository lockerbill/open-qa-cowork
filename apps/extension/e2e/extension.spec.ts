import { test, expect, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const distPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const FIXTURE = 'http://localhost:5555/spa.html';

let context: BrowserContext;
let worker: Worker;

async function background(ctx: BrowserContext): Promise<Worker> {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker');
  return sw;
}

async function activeTabId(): Promise<number> {
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ active: true }));
  return tab!.id!;
}

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  });
  worker = await background(context);
});

test.afterAll(async () => {
  await context?.close();
});

test('content script scans the page into a redacted page model (spec §9.2)', async () => {
  const page = await context.newPage();
  await page.goto(FIXTURE);
  await page.fill('#supplier', 'Acme Corp');
  await page.fill('#pw', 'hunter2');

  const tabId = await activeTabId();
  await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'SCAN_PAGE' }), tabId);

  await expect
    .poll(
      async () => {
        const r = await worker.evaluate(() => chrome.storage.local.get('pageModel'));
        return r.pageModel?.elements?.length ?? 0;
      },
      { timeout: 5000 },
    )
    .toBeGreaterThanOrEqual(6);

  const { pageModel } = await worker.evaluate(() => chrome.storage.local.get('pageModel'));
  expect(pageModel.summary.buttons).toContain('Submit');
  expect(pageModel.elements.some((e: any) => e.sensitive)).toBe(true);
  // The secret must never appear anywhere in the model (spec §17.3).
  expect(JSON.stringify(pageModel)).not.toContain('hunter2');
  await page.close();
});

test('records a flow without leaking secrets and tracks SPA navigation (spec §9.3, §9.4)', async () => {
  const page = await context.newPage();
  await page.goto(FIXTURE);
  const tabId = await activeTabId();

  // Start a recording session (mirror the panel's START_RECORDING).
  await worker.evaluate((id) => {
    const session = {
      id: 'e2e_session',
      startedAt: new Date().toISOString(),
      status: 'recording',
      events: [],
      evidence: [],
      consoleErrors: [],
      networkFailures: [],
      baseUrl: 'http://localhost:5555/spa.html',
    };
    return chrome.storage.local
      .set({ session })
      .then(() => chrome.tabs.sendMessage(id, { type: 'START_RECORDING' }));
  }, tabId);

  await page.fill('#supplier', 'Acme Corp');
  await page.fill('#pw', 'hunter2');
  await page.click('[data-testid="submit-order"]');
  await page.click('[data-testid="nav-summary"]'); // SPA pushState

  // Wait until the navigation event (last action) has landed.
  await expect
    .poll(
      async () => {
        const r = await worker.evaluate(() => chrome.storage.local.get('session'));
        return (r.session?.events ?? []).some((e: any) => e.type === 'navigation');
      },
      { timeout: 6000 },
    )
    .toBe(true);

  const { session } = await worker.evaluate(() => chrome.storage.local.get('session'));
  const events: any[] = session.events;
  expect(events.some((e) => e.type === 'input' && e.value === 'Acme Corp')).toBe(true);
  const sensitive = events.find((e) => e.type === 'input' && e.valueType === 'sensitive');
  expect(sensitive).toBeTruthy();
  expect(sensitive.value).toBeUndefined();
  // No secret anywhere in the session (spec §17.3).
  expect(JSON.stringify(session)).not.toContain('hunter2');
  await page.close();
});
