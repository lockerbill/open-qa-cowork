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
 *      (Not needed in smoke mode — see EVAL_DECIDER_URL.)
 *
 * Environment:
 *   EVAL_PROVIDER_BASE_URL  (required*) e.g. https://openrouter.ai/api/v1
 *   EVAL_PROVIDER_MODEL     (required*) e.g. tencent/hy3
 *   EVAL_PROVIDER_API_KEY   (default 'not-needed' — fine for local servers)
 *   EVAL_SERVER_URL         (default http://localhost:8787)
 *   EVAL_FIXTURE_URL        (default http://localhost:5555/eval-buggy.html)
 *   EVAL_RUNS               (default 3)
 *   EVAL_MAX_STEPS          (default 20)
 *   EVAL_RUN_TIMEOUT_MS     (default 20 min) harness deadline per run; the
 *                           controller's own wall-clock budget is derived
 *                           from it so healthy-but-slow runs stop as
 *                           stopped_by_budget, not harness_error
 *   EVAL_STOP_GRACE_MS      (default 30 s) wait for a stopped run to
 *                           finalize before force-resetting the controller
 *   EVAL_DECIDER_URL        smoke mode: POST the stub decider (e2e/
 *                           stub-decider.ts, :5557) directly — no API
 *                           server, no provider, no credits (*provider
 *                           envs become optional)
 *   EVAL_GOAL               override the run goal (smoke mode uses the
 *                           stub's `scenario:<name>` selection)
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
const DECIDER_URL = process.env.EVAL_DECIDER_URL;
const RUNS = Number(process.env.EVAL_RUNS ?? 3);
const MAX_STEPS = Number(process.env.EVAL_MAX_STEPS ?? 20);
const RUN_TIMEOUT_MS = Number(process.env.EVAL_RUN_TIMEOUT_MS ?? 20 * 60_000);
const STOP_GRACE_MS = Number(process.env.EVAL_STOP_GRACE_MS ?? 30_000);
/**
 * Controller wall-clock budget: the harness deadline minus headroom for one
 * worst-case in-flight step (decide 120 s + one retry + execute/settle —
 * budgets are only checked between steps), so slow-but-healthy runs end as
 * stopped_by_budget (a real, scoreable status with metrics) instead of
 * harness_error. The 60 s floor means tiny smoke-run timeouts intentionally
 * hit the harness deadline (+ ensureRunEnded) instead.
 */
const RUN_WALL_CLOCK_MS = Math.max(60_000, RUN_TIMEOUT_MS - 5 * 60_000);

const GOAL =
  process.env.EVAL_GOAL ??
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
  /** Present on harness_error rows: what killed the run. */
  error?: string;
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

/** Thrown out of runOnce so the catch path can score the run's real progress. */
class HarnessRunError extends Error {
  constructor(
    message: string,
    readonly lastState: AutoState | null,
  ) {
    super(message);
  }
}

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

const getAutoState = async (worker: Worker): Promise<AutoState | null> =>
  (await worker.evaluate(() => (globalThis as any).__openqaAuto.getState())) as AutoState | null;

/**
 * Every exit path of a run ends here: stop the run and WAIT for it to reach a
 * final status before the next run starts — a run left active makes every
 * later start() throw 'an auto run is already active'. A run that will not
 * finalize within the grace window (e.g. wedged mid-await) is force-reset as
 * a last resort.
 */
async function ensureRunEnded(worker: Worker): Promise<void> {
  let state = await getAutoState(worker);
  if (!state || FINAL.has(state.status)) return;
  await worker.evaluate(() => (globalThis as any).__openqaAuto.stop());
  const grace = Date.now() + STOP_GRACE_MS;
  while (Date.now() < grace) {
    state = await getAutoState(worker);
    if (!state || FINAL.has(state.status)) return;
    await sleep(500);
  }
  console.warn(
    `  run did not finalize within ${STOP_GRACE_MS}ms of stop; force-resetting the controller`,
  );
  await worker.evaluate(() => (globalThis as any).__openqaAuto.reset());
}

async function runOnce(
  context: BrowserContext,
  worker: Worker,
  run: number,
  bugs: SeededBug[],
): Promise<RunScore> {
  const page = await context.newPage();
  let state: AutoState | null = null;
  try {
    await page.goto(FIXTURE_URL);
    const [tab] = await worker.evaluate(() => chrome.tabs.query({ active: true }));
    const tabId = tab!.id!;

    await worker.evaluate(
      ([goal, tabId, maxSteps, maxWallClockMs, origin, deciderBaseUrl]) =>
        (globalThis as any).__openqaAuto.start(
          {
            goal,
            mode: 'autonomous',
            maxSteps,
            maxWallClockMs,
            maxLlmCalls: (maxSteps as number) + 10,
            originAllowlist: [origin],
            ...(deciderBaseUrl ? { deciderBaseUrl } : {}),
          },
          tabId,
        ),
      [
        GOAL,
        tabId,
        MAX_STEPS,
        RUN_WALL_CLOCK_MS,
        new URL(FIXTURE_URL).origin,
        DECIDER_URL ?? '',
      ] as const,
    );

    const deadline = Date.now() + RUN_TIMEOUT_MS;
    for (;;) {
      state = await getAutoState(worker);
      if (state && FINAL.has(state.status)) break;
      if (Date.now() > deadline) {
        throw new HarnessRunError(
          `run ${run} timed out after ${RUN_TIMEOUT_MS}ms (status ${state?.status})`,
          state,
        );
      }
      await sleep(1000);
    }

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
  } catch (err) {
    // The last polled state rides the error: by the time the caller's catch
    // runs, the finally below may have stopped/reset the controller, so a
    // fresh poll would read nothing.
    throw err instanceof HarnessRunError
      ? err
      : new HarnessRunError(err instanceof Error ? err.message : String(err), state);
  } finally {
    await ensureRunEnded(worker).catch(() => {});
    await page.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  if (!DECIDER_URL && (!PROVIDER_BASE_URL || !PROVIDER_MODEL)) {
    console.error(
      'Set EVAL_PROVIDER_BASE_URL and EVAL_PROVIDER_MODEL (see the script header), ' +
        'or EVAL_DECIDER_URL for a stub-decider smoke run.',
    );
    process.exit(2);
  }

  const manifest = JSON.parse(
    readFileSync(join(here, 'seeded-bugs.json'), 'utf8'),
  ) as { bugs: SeededBug[] };
  const promptVersion = createHash('sha256')
    .update(readFileSync(systemPromptPath, 'utf8'))
    .digest('hex')
    .slice(0, 12);

  console.log(`server:   ${DECIDER_URL ? '(none — stub decider)' : SERVER_URL}`);
  console.log(`fixture:  ${FIXTURE_URL} (${manifest.bugs.length} seeded bugs)`);
  console.log(`provider: ${PROVIDER_MODEL ?? 'stub'} @ ${DECIDER_URL ?? PROVIDER_BASE_URL}`);
  console.log(`prompt:   version ${promptVersion}`);
  console.log(`runs:     ${RUNS} × autonomous, maxSteps ${MAX_STEPS}\n`);

  // Smoke mode: the SW POSTs the stub decider directly (deciderBaseUrl
  // override) — no API server, no provider, no credits; auth is dummies.
  const { token, workspaceId, email } = DECIDER_URL
    ? { token: '', workspaceId: '', email: 'smoke' }
    : await setUpWorkspace();
  if (!DECIDER_URL) console.log(`workspace ${workspaceId} ready (${email})\n`);

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
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  run ${run} failed: ${message}`);
      const last = err instanceof HarnessRunError ? err.lastState : null;
      scores.push({
        run,
        status: 'harness_error',
        error: message,
        stepsUsed: last?.budgets.stepsUsed ?? 0,
        llmCalls: last?.budgets.llmCalls ?? 0,
        correctionTurns: last?.budgets.correctionTurns ?? 0,
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
  const modelSlug = (PROVIDER_MODEL ?? 'stub').toLowerCase().replace(/[^a-z0-9.]+/g, '-');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join(resultsRoot, promptVersion);
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${modelSlug}-${stamp}.json`);
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        promptVersion,
        model: PROVIDER_MODEL ?? 'stub',
        providerBaseUrl: DECIDER_URL ?? PROVIDER_BASE_URL,
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

  if (completed.length === 0) {
    console.error(
      `\nEVAL FAILED: 0/${RUNS} runs completed (all harness_error) — ` +
        `results kept for forensics at ${outFile}`,
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
