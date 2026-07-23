/**
 * M2 acceptance (auto-test-mode-spec §13.2, §14): E2E scenarios 1, 5, 6, 8, 9
 * with the deterministic stub decider (e2e/stub-decider.ts) driving the FULL
 * extension loop — side panel surface (__openqaAuto) → service-worker run
 * controller → content-script PageDriver → fixture pages. Hermetic: no LLM,
 * no app server.
 */
import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { buildPlaywrightSpec } from '@qa-copilot/shared';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const FIXTURE = 'http://localhost:5555/auto-playground.html';
const STUB_DECIDER = 'http://127.0.0.1:5557';

let context: BrowserContext;
let worker: Worker;

async function background(ctx: BrowserContext): Promise<Worker> {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker');
  return sw;
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

interface AutoState {
  runId: string;
  status: string;
  phase: string;
  detail?: string;
  outcome?: string;
  reason?: string;
  trace: Array<Record<string, any>>;
  budgets: Record<string, number>;
}

function getState(): Promise<AutoState | null> {
  return worker.evaluate(() => (globalThis as any).__openqaAuto.getState()) as Promise<AutoState | null>;
}

async function waitForStatus(status: string, timeoutMs = 25_000): Promise<AutoState> {
  await expect
    .poll(async () => (await getState())?.status, { timeout: timeoutMs })
    .toBe(status);
  return (await getState())!;
}

async function startRun(
  goal: string,
  overrides: Record<string, unknown> = {},
): Promise<{ page: Page; tabId: number; runId: string }> {
  const page = await context.newPage();
  await page.goto(FIXTURE);
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ active: true }));
  const tabId = tab!.id!;
  const runId = (await worker.evaluate(
    ([goal, tabId, overrides]) =>
      (globalThis as any).__openqaAuto.start(
        {
          goal,
          mode: 'autonomous',
          maxSteps: 25,
          maxWallClockMs: 60_000,
          maxLlmCalls: 40,
          originAllowlist: ['http://localhost:5555'],
          deciderBaseUrl: 'http://127.0.0.1:5557',
          ...(overrides as object),
        },
        tabId,
      ),
    [goal, tabId, overrides] as const,
  )) as string;
  return { page, tabId, runId };
}

test.describe.configure({ mode: 'serial' });

test('scenario 1 — happy path: login → create item → assert → finish(pass); trace, recorder session, and Playwright draft carry the steps with selectors', async () => {
  test.setTimeout(60_000);
  // The password rides the credential vault (§9.4): the stub decider emits
  // {{TEST_USER_PASSWORD}}; the SW substitutes the seeded value at execution.
  await fetch(`${STUB_DECIDER}/captured`, { method: 'DELETE' });
  await worker.evaluate(() =>
    chrome.storage.session.set({ autoVault: { TEST_USER_PASSWORD: 'Secret123!' } }),
  );
  const { page } = await startRun('scenario:happy_path');
  const final = await waitForStatus('finished', 40_000);

  // Outcome + trace shape: 5 element actions + assert + finish, all ok.
  expect(final.outcome).toBe('pass');
  expect(final.trace).toHaveLength(7);
  for (const step of final.trace) expect(step.result).toBe('ok');
  const elementSteps = final.trace.filter((s) => ['click', 'fill'].includes(s.action.type));
  expect(elementSteps).toHaveLength(5);
  for (const step of elementSteps) {
    expect(step.durableSelector).toBeTruthy();
    expect(step.elementText).toBeTruthy();
  }
  const assertStep = final.trace[5]!;
  expect(assertStep.action.type).toBe('assert');
  expect(assertStep.action.holds).toBe(true);

  // The flow really ran: the item the decider named is on the page — which
  // also proves the vault substituted the real password (login gates on it).
  await expect(page.locator('#items li', { hasText: 'Widget' })).toBeVisible();

  // Secret-absence instrumentation (22.5, §14): the trace stays tokenized and
  // the secret value appears in NO decider request (what a model would see),
  // no persisted run state, and (below) no recorder session.
  const passwordStep = final.trace[1]!;
  expect(passwordStep.action.value).toBe('{{TEST_USER_PASSWORD}}');
  expect(JSON.stringify(final)).not.toContain('Secret123!');
  const capturedBodies = (await (await fetch(`${STUB_DECIDER}/captured`)).json()) as string[];
  expect(capturedBodies.length).toBeGreaterThanOrEqual(7);
  for (const body of capturedBodies) expect(body).not.toContain('Secret123!');
  expect(capturedBodies.some((b) => b.includes('{{TEST_USER_PASSWORD}}'))).toBe(true);
  expect(capturedBodies[0]).toContain('"placeholders":["TEST_USER_PASSWORD"]');
  const { autoRun } = await worker.evaluate(() => chrome.storage.session.get('autoRun'));
  expect(JSON.stringify(autoRun)).not.toContain('Secret123!');

  // Recorder session: exactly one source:'auto' event per element action,
  // each with a durable selector candidate (§6.4.9).
  const { session } = await worker.evaluate(() => chrome.storage.local.get('session'));
  const autoEvents = session.events.filter((e: any) => e.source === 'auto');
  expect(autoEvents).toHaveLength(5);
  for (const event of autoEvents) {
    expect(event.selectorCandidates?.length ?? 0).toBeGreaterThan(0);
  }
  expect(session.events).toHaveLength(5); // nothing double-captured
  expect(JSON.stringify(session)).not.toContain('Secret123!');
  expect(session.status).toBe('stopped');

  // Playwright draft (existing deterministic generator) contains the steps
  // with the recorded selectors.
  const spec = buildPlaywrightSpec(session);
  expect(spec.content).toContain('Widget');
  expect(spec.content).toContain('Sign in');
  expect((spec.content.match(/page\./g) ?? []).length).toBeGreaterThanOrEqual(4);

  await page.close();
});

test('scenario 5 — navigation: cross-page click re-handshakes and continues with a fresh observation', async () => {
  test.setTimeout(60_000);
  const { page } = await startRun('scenario:navigation');
  const final = await waitForStatus('finished', 40_000);

  expect(final.outcome).toBe('pass');
  expect(final.trace).toHaveLength(3);
  // The click navigated; the loop kept going on the new document.
  expect(final.trace[0]!.action.type).toBe('click');
  expect(final.trace[0]!.result).toBe('ok');
  // The assert holds only if the SW obtained a FRESH observation of the
  // second page after re-handshaking — that is the re-handshake proof.
  expect(final.trace[1]!.action.type).toBe('assert');
  expect(final.trace[1]!.action.holds).toBe(true);
  expect(final.trace[1]!.urlBefore).toContain('auto-second.html');
  expect(page.url()).toContain('auto-second.html');

  await page.close();
});

test('scenario 6 — stale epoch: an out-of-band observe invalidates the snapshot; executor rejects; SW re-observes once and continues', async () => {
  test.setTimeout(60_000);
  const { page, tabId, runId } = await startRun('scenario:stale_epoch');

  // The stub delays its first decision 1.5 s; slip in an extra AUTO_OBSERVE
  // so the driver's epoch advances past the one the SW is about to execute.
  await expect.poll(async () => (await getState())?.phase, { timeout: 10_000 }).toBe('deciding');
  const { autoRun } = await worker.evaluate(() => chrome.storage.session.get('autoRun'));
  expect(autoRun.runId).toBe(runId);
  await worker.evaluate(
    ([tabId, runId, sessionId]) =>
      chrome.tabs.sendMessage(tabId as number, { type: 'AUTO_OBSERVE', runId, sessionId }),
    [tabId, runId, autoRun.sessionId] as const,
  );

  const final = await waitForStatus('finished', 40_000);
  expect(final.outcome).toBe('pass');
  // Exactly one re-observe/re-decide, and the retried step still succeeded
  // without consuming an extra step (§7.2).
  expect(final.budgets.staleEpochRetries).toBe(1);
  expect(final.trace).toHaveLength(2);
  expect(final.trace[0]!.action.type).toBe('fill');
  expect(final.trace[0]!.result).toBe('ok');

  await page.close();
});

test('scenario 8 — budget: maxSteps=3 stops cleanly as stopped_by_budget with the partial trace', async () => {
  test.setTimeout(60_000);
  const { page } = await startRun('scenario:budget', { maxSteps: 3, maxLlmCalls: 40 });
  const final = await waitForStatus('stopped_by_budget', 40_000);

  expect(final.detail).toBe('max steps reached');
  expect(final.trace).toHaveLength(3);
  for (const step of final.trace) expect(step.action.type).toBe('scroll');

  await page.close();
});

test('scenario 9 — kill switch: trusted keypress pauses the run; overlay Stop ends it', async () => {
  test.setTimeout(60_000);
  const { page } = await startRun('scenario:kill_switch');

  // The stop pill is on the page while the run is active (§6.6).
  const pill = page.getByText('Auto test running');
  await expect(pill).toBeVisible({ timeout: 15_000 });

  // Trusted keypress outside the overlay → intervention → pause, not kill.
  await page.keyboard.press('a');
  const paused = await waitForStatus('paused', 20_000);
  expect(paused.detail).toBe('user_intervened');
  await expect(pill).toBeHidden(); // pill hidden while paused

  // Resume returns to observing and the pill comes back.
  await worker.evaluate(() => (globalThis as any).__openqaAuto.resume());
  await expect(pill).toBeVisible({ timeout: 15_000 });

  // Overlay Stop button ends the run.
  await page.getByRole('button', { name: 'Stop' }).click();
  const final = await waitForStatus('stopped_by_user', 20_000);
  expect(final.phase).toBe('done');
  await expect(pill).toBeHidden();

  await page.close();
});

test('reset() force-recovers a wedged controller so the next run can start (eval-harness last resort)', async () => {
  test.setTimeout(60_000);
  const { page } = await startRun('scenario:kill_switch');
  await waitForStatus('running', 20_000);

  // Force-reset while the run is live: state and the persisted record clear…
  await worker.evaluate(() => (globalThis as any).__openqaAuto.reset());
  expect(await getState()).toBeNull();
  const { autoRun } = await worker.evaluate(() => chrome.storage.session.get('autoRun'));
  expect(autoRun).toBeUndefined();

  // …and a new run starts immediately — no 'an auto run is already active'.
  const second = await startRun('scenario:budget', { maxSteps: 2 });
  const final = await waitForStatus('stopped_by_budget', 30_000);
  expect(final.runId).toBe(second.runId);
  expect(final.detail).toBe('max steps reached');

  await page.close();
  await second.page.close();
});
