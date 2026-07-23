/**
 * Model-quality eval harness (auto-test-mode-spec §13.3, task 30.2) — NON-CI.
 *
 * Runs N real-LLM autonomous auto-test runs against the seeded-bug fixture
 * (fixtures/eval-buggy.html, 11 seeded bugs — see seeded-bugs.json) through
 * the REAL stack, then scores bugs-found / steps-used / false-defects by
 * matching each run's `report_defect` output against the seeded-bug keyword
 * manifest. Scores are stored per prompt version (sha256 of the server's
 * system-prompt.md) under eval/results/ at the repo root so prompt changes
 * have a regression signal.
 *
 * Prerequisites (all outside this script — same stack as the M3 acceptance):
 *   1. Built extension:            pnpm --filter @qa-copilot/extension build
 *   2. Fixture server on :5555:    node e2e/serve.mjs
 *   3. Real API server running with platform env (DATABASE_URL, JWT_SECRET,
 *      MASTER_ENCRYPTION_KEY; plus ALLOW_PRIVATE_LLM_HOSTS=true for a local
 *      provider):                  pnpm --filter @qa-copilot/server dev
 *
 * Environment:
 *   EVAL_PROVIDER_BASE_URL  (required) e.g. https://openrouter.ai/api/v1
 *   EVAL_PROVIDER_MODEL     (required) e.g. tencent/hy3
 *   EVAL_PROVIDER_API_KEY   (default 'not-needed' — fine for local servers)
 *   EVAL_SERVER_URL         (default http://localhost:8787)
 *   EVAL_FIXTURE_URL        (default http://localhost:5555/eval-buggy.html)
 *   EVAL_RUNS               (default 3)
 *   EVAL_MAX_STEPS          (default 20)
 *
 * Usage: pnpm exec tsx e2e/eval/run-eval.ts
 */
import { chromium, type BrowserContext, type Worker } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distPath = join(here, '..', '..', 'dist');
const repoRoot = join(here, '..', '..', '..', '..');
const systemPromptPath = join(repoRoot, 'apps', 'server', 'src', 'modules', 'auto', 'system-prompt.md');
const resultsRoot = join(repoRoot, 'eval', 'results');

const SERVER_URL = process.env.EVAL_SERVER_URL ?? 'http://localhost:8787';
const FIXTURE_URL = process.env.EVAL_FIXTURE_URL ?? 'http://localhost:5555/eval-buggy.html';
const PROVIDER_BASE_URL = process.env.EVAL_PROVIDER_BASE_URL;
const PROVIDER_MODEL = process.env.EVAL_PROVIDER_MODEL;
const PROVIDER_API_KEY = process.env.EVAL_PROVIDER_API_KEY ?? 'not-needed';
const RUNS = Number(process.env.EVAL_RUNS ?? 3);
const MAX_STEPS = Number(process.env.EVAL_MAX_STEPS ?? 20);
const RUN_TIMEOUT_MS = Number(process.env.EVAL_RUN_TIMEOUT_MS ?? 20 * 60_000);

const GOAL =
  'Exploratory-test this TaskTrack page and report every bug you find. Try every button, ' +
  'form, link, and control, including edge cases. Verify behavior with assert, call ' +
  'report_defect exactly once per distinct bug, and finish with your verdict once the page ' +
  'is fully covered.';

interface SeededBug {
  id: string;
  title: string;
  keywords: string[];
}

interface Defect {
  summary: string;
  expected: string;
  actual: string;
  severity?: string;
}

interface RunScore {
  run: number;
  status: string;
  outcome?: string;
  stepsUsed: number;
  llmCalls: number;
  correctionTurns: number;
  defects: Defect[];
  bugsFound: string[];
  falseDefects: number;
}

interface AutoState {
  status: string;
  outcome?: string;
  trace: Array<{ result: string; action: { type: string } & Defect }>;
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
  const email = `eval-${Date.now().toString(36)}@example.com`;
  const reg = await api<{ token: string; workspace: { id: string } }>('/api/auth/register', {
    email,
    password: 'eval-password-1',
    displayName: 'Eval Harness',
  });
  const provider = await api<{ id: string }>(
    `/api/workspaces/${reg.workspace.id}/llm-providers`,
    {
      displayName: 'Eval provider',
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

/** A defect "finds" every seeded bug with a keyword hit in its text (§13.3). */
function matchBugs(defect: Defect, bugs: SeededBug[]): string[] {
  const text = `${defect.summary} ${defect.expected} ${defect.actual}`.toLowerCase();
  return bugs.filter((bug) => bug.keywords.some((k) => text.includes(k.toLowerCase()))).map((b) => b.id);
}

async function runOnce(
  context: BrowserContext,
  worker: Worker,
  run: number,
  bugs: SeededBug[],
): Promise<RunScore> {
  const page = await context.newPage();
  await page.goto(FIXTURE_URL);
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ active: true }));
  const tabId = tab!.id!;

  await worker.evaluate(
    ([goal, tabId, maxSteps, origin]) =>
      (globalThis as any).__openqaAuto.start(
        {
          goal,
          mode: 'autonomous',
          maxSteps,
          maxWallClockMs: 15 * 60_000,
          maxLlmCalls: (maxSteps as number) + 10,
          originAllowlist: [origin],
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

  // Defects from the persisted RunResult (§5.4); fall back to the trace.
  const stored = (await worker.evaluate(() => chrome.storage.local.get('session'))) as {
    session?: { autoRunResult?: { defects?: Defect[] } };
  };
  const defects: Defect[] =
    stored.session?.autoRunResult?.defects ??
    state!.trace
      .filter((s) => s.action.type === 'report_defect' && s.result === 'ok')
      .map((s) => s.action);

  const bugsFound = [...new Set(defects.flatMap((d) => matchBugs(d, bugs)))];
  const falseDefects = defects.filter((d) => matchBugs(d, bugs).length === 0).length;

  return {
    run,
    status: state!.status,
    outcome: state!.outcome,
    stepsUsed: state!.budgets.stepsUsed,
    llmCalls: state!.budgets.llmCalls,
    correctionTurns: state!.budgets.correctionTurns ?? 0,
    defects,
    bugsFound,
    falseDefects,
  };
}

async function main(): Promise<void> {
  if (!PROVIDER_BASE_URL || !PROVIDER_MODEL) {
    console.error('Set EVAL_PROVIDER_BASE_URL and EVAL_PROVIDER_MODEL (see the script header).');
    process.exit(2);
  }

  const manifest = JSON.parse(
    readFileSync(join(here, 'seeded-bugs.json'), 'utf8'),
  ) as { bugs: SeededBug[] };
  const promptVersion = createHash('sha256')
    .update(readFileSync(systemPromptPath, 'utf8'))
    .digest('hex')
    .slice(0, 12);

  console.log(`server:   ${SERVER_URL}`);
  console.log(`fixture:  ${FIXTURE_URL} (${manifest.bugs.length} seeded bugs)`);
  console.log(`provider: ${PROVIDER_MODEL} @ ${PROVIDER_BASE_URL}`);
  console.log(`prompt:   version ${promptVersion}`);
  console.log(`runs:     ${RUNS} × autonomous, maxSteps ${MAX_STEPS}\n`);

  const { token, workspaceId, email } = await setUpWorkspace();
  console.log(`workspace ${workspaceId} ready (${email})\n`);

  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');

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
          currentWorkspaceName: 'Eval Harness',
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

  const scores: RunScore[] = [];
  for (let run = 1; run <= RUNS; run++) {
    console.log(`run ${run}/${RUNS}…`);
    try {
      const score = await runOnce(context, worker, run, manifest.bugs);
      scores.push(score);
      console.log(
        `  ${score.status}${score.outcome ? ` (${score.outcome})` : ''} — ` +
          `steps ${score.stepsUsed}, bugs ${score.bugsFound.length}/${manifest.bugs.length} ` +
          `[${score.bugsFound.join(', ')}], false ${score.falseDefects}`,
      );
    } catch (err) {
      console.error(`  run ${run} failed: ${err instanceof Error ? err.message : String(err)}`);
      scores.push({
        run,
        status: 'harness_error',
        stepsUsed: 0,
        llmCalls: 0,
        correctionTurns: 0,
        defects: [],
        bugsFound: [],
        falseDefects: 0,
      });
    }
  }
  await context.close();

  const completed = scores.filter((s) => s.status !== 'harness_error');
  const uniqueBugsFound = [...new Set(completed.flatMap((s) => s.bugsFound))];
  const aggregate = {
    seededBugs: manifest.bugs.length,
    uniqueBugsFound: uniqueBugsFound.length,
    uniqueBugIds: uniqueBugsFound,
    avgBugsFoundPerRun:
      completed.length > 0
        ? completed.reduce((n, s) => n + s.bugsFound.length, 0) / completed.length
        : 0,
    avgStepsUsed:
      completed.length > 0
        ? completed.reduce((n, s) => n + s.stepsUsed, 0) / completed.length
        : 0,
    totalFalseDefects: completed.reduce((n, s) => n + s.falseDefects, 0),
    completedRuns: completed.length,
    requestedRuns: RUNS,
  };

  // §13.3: store per prompt version so prompt changes have a regression signal.
  const modelSlug = PROVIDER_MODEL.toLowerCase().replace(/[^a-z0-9.]+/g, '-');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join(resultsRoot, promptVersion);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${modelSlug}-${stamp}.json`);
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        promptVersion,
        model: PROVIDER_MODEL,
        providerBaseUrl: PROVIDER_BASE_URL,
        fixture: FIXTURE_URL,
        generatedAt: new Date().toISOString(),
        aggregate,
        runs: scores,
      },
      null,
      2,
    ),
  );

  console.log('\n=== Eval scores ===');
  console.table(
    scores.map(({ run, status, stepsUsed, bugsFound, falseDefects }) => ({
      run,
      status,
      stepsUsed,
      bugs: bugsFound.length,
      false: falseDefects,
    })),
  );
  console.log(
    `unique bugs found: ${aggregate.uniqueBugsFound}/${aggregate.seededBugs} · ` +
      `avg steps ${aggregate.avgStepsUsed.toFixed(1)} · false defects ${aggregate.totalFalseDefects}`,
  );
  console.log(`scores written to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
