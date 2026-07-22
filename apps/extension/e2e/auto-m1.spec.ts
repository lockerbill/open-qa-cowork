/**
 * M1 acceptance (auto-test-mode-spec §14): a hardcoded action list — no LLM,
 * no server — drives the fixture login flow end-to-end through
 * PageDriver.observe/execute, and the recorder event stream contains the
 * actions as source:'auto' events with durable selectors, exactly once each
 * (the manual recorder runs simultaneously; the auto-dispatch gate dedupes).
 */
import { test, expect } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(here, 'dist', 'auto-harness.js');
const INJECTED = join(here, '..', 'public', 'injected.js');

test.beforeEach(async ({ page }) => {
  await page.goto('/auto-playground.html');
  await page.addScriptTag({ path: INJECTED }); // main-world capture (network/console)
  await page.addScriptTag({ path: HARNESS });
});

test('hardcoded action list drives the login flow end-to-end', async ({ page }) => {
  const run = await page.evaluate(async () => {
    const h = window.__openqaHarness;
    const events: unknown[] = [];
    // The REAL manual recorder runs during the auto actions — dedupe proof.
    const recorder = h.createRecorder('run_m1', (e) => events.push(e), document);
    recorder.start();
    const driver = h.createPageDriver({
      sessionId: 'run_m1',
      emitRecorderEvent: (e) => events.push(e),
    });

    const results = [];
    let { observation, elements } = await driver.observe();
    const serializedBefore = observation.serialized;

    const emailIndex = elements.find((el) => el.attributes['name'] === 'email')?.index;
    results.push(
      await driver.execute(
        { type: 'fill', index: emailIndex!, value: 'qa@example.com', intent: 'enter email' },
        observation.epoch,
      ),
    );

    ({ observation, elements } = await driver.observe());
    const passwordIndex = elements.find((el) => el.tag === 'input' && el.isSecret)?.index;
    results.push(
      await driver.execute(
        { type: 'fill', index: passwordIndex!, value: 'Secret123!', intent: 'enter password' },
        observation.epoch,
      ),
    );

    ({ observation, elements } = await driver.observe());
    const signInIndex = elements.find((el) => el.text === 'Sign in')?.index;
    results.push(
      await driver.execute(
        { type: 'click', index: signInIndex!, intent: 'submit login' },
        observation.epoch,
      ),
    );

    const final = await driver.observe();
    driver.dispose();
    recorder.stop();
    return {
      results,
      events: events as Array<Record<string, unknown>>,
      serializedBefore,
      finalSerialized: final.observation.serialized,
      finalEpoch: final.observation.epoch,
    };
  });

  // Every action executed successfully with a durable selector recorded.
  expect(run.results).toHaveLength(3);
  for (const result of run.results) {
    expect(result.ok).toBe(true);
    expect(result.durableSelector).toBeTruthy();
  }

  // The flow really completed: the dashboard replaced the login form.
  expect(run.finalSerialized).toContain('Welcome back, QA!');
  expect(run.finalSerialized).not.toContain('Sign in');
  expect(run.finalEpoch).toBe(4);

  // Recorder stream: exactly one source:'auto' event per action — the manual
  // recorder skipped our synthetic DOM events (dedupe), so nothing doubled.
  expect(run.events).toHaveLength(3);
  const [emailEvent, passwordEvent, clickEvent] = run.events;
  expect(emailEvent).toMatchObject({
    type: 'input',
    source: 'auto',
    intent: 'enter email',
    valueType: 'text',
    value: 'qa@example.com',
    sessionId: 'run_m1',
  });
  expect(passwordEvent).toMatchObject({ type: 'input', source: 'auto', valueType: 'sensitive' });
  expect(clickEvent).toMatchObject({ type: 'click', source: 'auto', targetLabel: 'Sign in' });
  for (const event of run.events) {
    const candidates = event.selectorCandidates as string[];
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]).toBeTruthy();
  }

  // The typed secret never appears in any recorded event (valueType:
  // 'sensitive' drops the value) nor in the post-login observation. The
  // PRE-login observation legitimately contains the string — the fixture's
  // visible hint text spells the creds, and redaction masks PII shapes
  // (emails, cards, tokens), not arbitrary page prose.
  expect(JSON.stringify(run.events)).not.toContain('Secret123!');
  expect(run.finalSerialized).not.toContain('Secret123!');
  // The creds hint's email IS a PII shape and must be tokenized.
  expect(run.serializedBefore).toContain('[EMAIL]');
  expect(run.serializedBefore).not.toContain('qa@example.com');
});

test('stale epoch is rejected and the map never guesses across snapshots', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = window.__openqaHarness;
    const driver = h.createPageDriver({ sessionId: 'run_stale', emitRecorderEvent: () => {} });
    const first = await driver.observe();
    await driver.observe(); // epoch advances; first snapshot is now stale
    const stale = await driver.execute(
      { type: 'click', index: first.elements[0]!.index, intent: 'stale click' },
      first.observation.epoch,
    );
    driver.dispose();
    return stale;
  });
  expect(result).toMatchObject({ ok: false, reason: 'stale_epoch' });
});
