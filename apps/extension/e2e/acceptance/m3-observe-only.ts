/**
 * M3 acceptance script (auto-test-mode-spec §14, task 20.2) — NON-CI.
 *
 * Runs N (default 5) observe-only auto-test explorations of the fixture SPA
 * through the REAL stack — built extension → service worker loop → real
 * `POST /api/workspaces/:id/auto/step` → a REAL provider — and computes the
 * correction-turn rate from the run budget counters. Accept: < 10 %.
 *
 * Prerequisites (all outside this script):
 *   1. Built extension:            pnpm --filter @qa-copilot/extension build
 *   2. Fixture server on :5555:    node e2e/serve.mjs
 *   3. Real API server running with platform env (DATABASE_URL, JWT_SECRET,
 *      MASTER_ENCRYPTION_KEY; plus ALLOW_PRIVATE_LLM_HOSTS=true for a local
 *      Ollama provider):           pnpm --filter @qa-copilot/server dev
 *
 * Environment:
 *   ACCEPT_PROVIDER_BASE_URL  (required) e.g. https://openrouter.ai/api/v1
 *                                        or   http://localhost:11434/v1
 *   ACCEPT_PROVIDER_MODEL     (required) e.g. anthropic/claude-sonnet-4
 *                                        or   qwen2.5:7b
 *   ACCEPT_PROVIDER_API_KEY   (default 'not-needed' — fine for Ollama)
 *   ACCEPT_SERVER_URL         (default http://localhost:8787)
 *   ACCEPT_FIXTURE_URL        (default http://localhost:5555/auto-playground.html)
 *   ACCEPT_RUNS               (default 5)
 *   ACCEPT_MAX_STEPS          (default 12)
 *
 * Usage: pnpm exec tsx e2e/acceptance/m3-observe-only.ts
 */
import { chromium, type BrowserContext, type Worker } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');

const SERVER_URL = process.env.ACCEPT_SERVER_URL ?? 'http://localhost:8787';
const FIXTURE_URL = process.env.ACCEPT_FIXTURE_URL ?? 'http://localhost:5555/auto-playground.html';
const PROVIDER_BASE_URL = process.env.ACCEPT_PROVIDER_BASE_URL;
const PROVIDER_MODEL = process.env.ACCEPT_PROVIDER_MODEL;
const PROVIDER_API_KEY = process.env.ACCEPT_PROVIDER_API_KEY ?? 'not-needed';
const RUNS = Number(process.env.ACCEPT_RUNS ?? 5);
const MAX_STEPS = Number(process.env.ACCEPT_MAX_STEPS ?? 12);
const RUN_TIMEOUT_MS = Number(process.env.ACCEPT_RUN_TIMEOUT_MS ?? 15 * 60_000);

const GOAL =
  'Explore this playground page in a read-only fashion: check that the login form and the ' +
  'item list render, follow links that look safe, verify what you observe with assert, and ' +
  'finish with your overall verdict. Do not try to modify any data.';

interface RunSummary {
  run: number;
  status: string;
  outcome?: string;
  stepsUsed: number;
  llmCalls: number;
  correctionTurns: number;
  refused: number;
  invalidSteps: number;
}

interface AutoState {
  status: string;
  outcome?: string;
  reason?: string;
  detail?: string;
  trace: Array<{ result: string; resultDetail?: string }>;
  budgets: { stepsUsed: number; llmCalls: number; correctionTurns?: number };
}

const FINAL = new Set(['finished', 'stopped_by_user', 'stopped_by_budget', 'error']);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function api<T>(path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

async function setUpWorkspace(): Promise<{ token: string; workspaceId: string; email: string }> {
  const email = `m3-acceptance-${Date.now().toString(36)}@example.com`;
  const reg = await api<{ token: string; workspace: { id: string } }>('/api/auth/register', {
    email,
    password: 'acceptance-password-1',
    displayName: 'M3 Acceptance',
  });
  const provider = await api<{ id: string }>(
    `/api/workspaces/${reg.workspace.id}/llm-providers`,
    {
      displayName: 'M3 acceptance provider',
      baseUrl: PROVIDER_BASE_URL,
      modelName: PROVIDER_MODEL,
      apiKey: PROVIDER_API_KEY,
    },
    reg.token,
  );
  await api(
    `/api/workspaces/${reg.workspace.id}/llm-providers/${provider.id}/set-default`,
    {},
    reg.token,
  );
  return { token: reg.token, workspaceId: reg.workspace.id, email };
}

async function background(ctx: BrowserContext): Promise<Worker> {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker');
  return sw;
}

async function runOnce(context: BrowserContext, worker: Worker, run: number): Promise<RunSummary> {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ active: true }));
  const tabId = tab!.id!;

  await worker.evaluate(
    ([goal, tabId, maxSteps, origin]) =>
      (globalThis as any).__openqaAuto.start(
        {
          goal,
          mode: 'observe_only',
          maxSteps,
          maxWallClockMs: 10 * 60_000,
          maxLlmCalls: (maxSteps as number) + 10,
          originAllowlist: [origin],
          // No deciderBaseUrl: the SW targets the real workspace endpoint.
        },
        tabId,
      ),
    [GOAL, tabId, MAX_STEPS, new URL(FIXTURE_URL).origin] as const,
  );

  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let state: AutoState | null = null;
  for (;;) {
    state = (await worker.evaluate(() =>
      (globalThis as any).__openqaAuto.getState(),
    )) as AutoState | null;
    if (state && FINAL.has(state.status)) break;
    if (Date.now() > deadline) {
      await worker.evaluate(() => (globalThis as any).__openqaAuto.stop());
      throw new Error(`run ${run} timed out after ${RUN_TIMEOUT_MS}ms (status ${state?.status})`);
    }
    await sleep(1000);
  }
  await page.close();

  return {
    run,
    status: state!.status,
    outcome: state!.outcome,
    stepsUsed: state!.budgets.stepsUsed,
    llmCalls: state!.budgets.llmCalls,
    correctionTurns: state!.budgets.correctionTurns ?? 0,
    refused: state!.trace.filter((s) => s.result === 'refused').length,
    invalidSteps: state!.trace.filter((s) => s.resultDetail === 'model_output_invalid').length,
  };
}

async function main(): Promise<void> {
  if (!PROVIDER_BASE_URL || !PROVIDER_MODEL) {
    console.error(
      'Set ACCEPT_PROVIDER_BASE_URL and ACCEPT_PROVIDER_MODEL (see the header of this script).',
    );
    process.exit(2);
  }

  console.log(`server:   ${SERVER_URL}`);
  console.log(`fixture:  ${FIXTURE_URL}`);
  console.log(`provider: ${PROVIDER_MODEL} @ ${PROVIDER_BASE_URL}`);
  console.log(`runs:     ${RUNS} × observe_only, maxSteps ${MAX_STEPS}\n`);

  const { token, workspaceId, email } = await setUpWorkspace();
  console.log(`workspace ${workspaceId} ready (${email})\n`);

  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  });
  const worker = await background(context);

  // Point the extension at the real server, signed in to the fresh workspace.
  await worker.evaluate(
    ([serverUrl, token, workspaceId, email]) =>
      chrome.storage.local.set({
        settings: {
          backendUrl: serverUrl,
          environment: 'staging',
          allowlist: [],
          noDestructiveMode: true,
        },
        auth: {
          token,
          userEmail: email,
          currentWorkspaceId: workspaceId,
          currentWorkspaceName: 'M3 Acceptance',
          currentWorkspaceRole: 'owner',
          currentProjectId: null,
          currentProjectName: null,
          currentEnvironmentId: null,
          currentEnvironmentName: null,
          contextSource: null,
        },
      }),
    [SERVER_URL, token, workspaceId, email] as const,
  );

  const summaries: RunSummary[] = [];
  for (let run = 1; run <= RUNS; run++) {
    console.log(`run ${run}/${RUNS}…`);
    try {
      const summary = await runOnce(context, worker, run);
      summaries.push(summary);
      console.log(
        `  ${summary.status}${summary.outcome ? ` (${summary.outcome})` : ''} — ` +
          `steps ${summary.stepsUsed}, llmCalls ${summary.llmCalls}, ` +
          `corrections ${summary.correctionTurns}, refused ${summary.refused}, ` +
          `invalid ${summary.invalidSteps}`,
      );
    } catch (err) {
      console.error(`  run ${run} failed: ${err instanceof Error ? err.message : String(err)}`);
      summaries.push({
        run,
        status: 'harness_error',
        stepsUsed: 0,
        llmCalls: 0,
        correctionTurns: 0,
        refused: 0,
        invalidSteps: 0,
      });
    }
  }
  await context.close();

  const llmCalls = summaries.reduce((n, s) => n + s.llmCalls, 0);
  const corrections = summaries.reduce((n, s) => n + s.correctionTurns, 0);
  const rate = llmCalls === 0 ? 1 : corrections / llmCalls;
  // Every run must actually complete (finish or clean budget stop) — a run
  // that died in `error` or never ran cannot count toward acceptance.
  const allCompleted = summaries.every(
    (s) => s.status === 'finished' || s.status === 'stopped_by_budget',
  );
  const pass = rate < 0.1 && allCompleted;

  console.log('\n=== M3 acceptance (observe-only, real provider) ===');
  console.table(summaries);
  console.log(
    `correction-turn rate: ${corrections}/${llmCalls} = ${(rate * 100).toFixed(1)} % ` +
      `(accept < 10 %) → ${pass ? 'PASS' : 'FAIL'}`,
  );
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
