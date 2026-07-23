/**
 * Service-worker run controller (auto-test-mode-spec §7): owns the run as a
 * state machine — idle → starting → observing → deciding → guarding →
 * (awaiting_confirmation) → executing → post_step → …loop… → finalizing →
 * done, with `paused` reachable from any active state and resume always
 * returning to `observing` (the human may have changed the page).
 *
 * Every chrome-touching operation arrives via `RunControllerDeps` so the
 * whole machine is unit-testable without a browser; `wiring.ts` provides the
 * chrome-backed implementation. State persists via deps.persist after every
 * transition (§7.1 MV3 caveat) and deps.pushState mirrors each transition to
 * the side panel as AUTO_STATE.
 */
import type {
  Action,
  HistoryEntry,
  Observation,
  ObservedElement,
  RunConfig,
  RunStatus,
  StepRequest,
  StepResponse,
  TraceStep,
} from '@qa-copilot/shared/auto';
import { RUN_DEFAULTS, zAction } from '@qa-copilot/shared/auto';
import { checkAction, isOriginAllowed } from './guard.js';
import { compressHistory } from './history.js';
import type {
  AutoExecuteResponse,
  AutoObserveResponse,
  AutoStateMsg,
  BudgetSnapshot,
  PersistedAutoRun,
  RunPhase,
} from './messages.js';

/**
 * Thrown by the decide dep on a 422 {error:'invalid_action'} response (§8.4).
 * The controller answers with a correction turn (§8.5) instead of failing the
 * run.
 */
export class DeciderValidationError extends Error {
  constructor(readonly detail: string) {
    super(`invalid_action: ${detail}`);
    this.name = 'DeciderValidationError';
  }
}

export interface RunControllerDeps {
  /** Send AUTO_OBSERVE; MUST reject when the content script is unreachable. */
  observe(tabId: number, runId: string, sessionId: string): Promise<AutoObserveResponse>;
  execute(tabId: number, runId: string, epoch: number, action: Action): Promise<AutoExecuteResponse>;
  showOverlay(tabId: number, runId: string): Promise<void>;
  hideOverlay(tabId: number, runId: string): Promise<void>;
  injectContentScript(tabId: number): Promise<boolean>;
  /**
   * POST {baseUrl}/auto/step (§8 contract; stub decider in M2 E2E). MUST throw
   * DeciderValidationError on a 422 so the controller can run correction turns.
   */
  decide(baseUrl: string, request: StepRequest): Promise<StepResponse>;
  getTabUrl(tabId: number): Promise<string | null>;
  /** Resolve when the tab reaches status 'complete' (or on timeout). */
  waitForTabLoad(tabId: number, timeoutMs: number): Promise<void>;
  /** Start a fresh recorder session for the run's auto events; returns its id. */
  startRecordingSession(tabId: number): Promise<string>;
  stopRecordingSession(tabId: number): Promise<void>;
  persist(state: PersistedAutoRun): Promise<void>;
  pushState(state: AutoStateMsg): void;
  log(message: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Content-script handshake budget after navigation / on no-response (§7.4). */
const HANDSHAKE_TIMEOUT_MS = 5000;
const HANDSHAKE_BACKOFF_MS = [200, 400, 800, 1600, 1600];
const TAB_LOAD_TIMEOUT_MS = 10_000;
/** Max correction turns per step (§8.5); they consume maxLlmCalls, not maxSteps. */
const MAX_CORRECTIONS_PER_STEP = 2;
/** One transient-decider-failure retry per step (502/504/network hiccup). */
const DECIDER_RETRY_BACKOFF_MS = 2000;

const FINAL_STATUSES: readonly RunStatus[] = [
  'finished',
  'stopped_by_user',
  'stopped_by_budget',
  'error',
];

interface RunInternal {
  runId: string;
  tabId: number;
  sessionId: string;
  config: RunConfig;
  /** Fixed at run start; NEVER updated from page content (§7.2). */
  goal: string;
  phase: RunPhase;
  detail?: string;
  trace: TraceStep[];
  history: HistoryEntry[];
  stepsUsed: number;
  llmCalls: number;
  startedAt: number;
  staleEpochRetries: number;
  correctionTurns: number;
  finalStatus?: RunStatus;
  outcome?: 'pass' | 'fail' | 'blocked';
  reason?: string;
}

interface ObserveBundle {
  observation: Observation;
  elements: ObservedElement[];
}

let runCounter = 0;

export class RunController {
  private run: RunInternal | null = null;
  private loopRunning = false;
  private resumeWaiter: (() => void) | null = null;
  private pauseRequested: string | null = null;
  private stopRequested: { status: RunStatus; detail?: string } | null = null;
  /** Bumped on every pause→resume cycle; lets runStep abandon a pre-pause decision. */
  private resumeCount = 0;
  /** Overlay presence tracker: navigations destroy the pill, observes restore it. */
  private overlayVisible = false;

  constructor(private deps: RunControllerDeps) {}

  // --- public control surface (panel / content-script messages) ------------

  /** Start a run on `tabId`. Rejects while another run is active (§7.1: one per profile). */
  async start(config: RunConfig, tabId: number): Promise<string> {
    if (this.isActive()) throw new Error('an auto run is already active');
    this.pauseRequested = null;
    this.stopRequested = null;

    runCounter += 1;
    const runId = `run_${this.deps.now().toString(36)}_${runCounter}`;
    const sessionId = await this.deps.startRecordingSession(tabId);
    this.run = {
      runId,
      tabId,
      sessionId,
      config: clampConfig(config),
      goal: config.goal,
      phase: 'idle',
      trace: [],
      history: [],
      stepsUsed: 0,
      llmCalls: 0,
      startedAt: this.deps.now(),
      staleEpochRetries: 0,
      correctionTurns: 0,
    };
    await this.transition('starting');
    await this.ensureOverlay();
    void this.loop();
    return runId;
  }

  /** True while a run exists and has not reached a final status. */
  isActive(): boolean {
    return this.run !== null && this.run.finalStatus === undefined;
  }

  activeRunId(): string | null {
    return this.run?.runId ?? null;
  }

  /**
   * Gate for every run-scoped message (§7.3): stale-runId messages are
   * dropped and logged, never acted on.
   */
  acceptsRunId(runId: string): boolean {
    if (this.run?.runId === runId) return true;
    this.deps.log(`auto: dropped message for stale runId ${runId} (active: ${this.run?.runId ?? 'none'})`);
    return false;
  }

  pause(detail: string): void {
    if (!this.isActive() || this.run!.phase === 'paused') return;
    this.pauseRequested = detail;
  }

  /** Resume always returns to `observing` via the loop top (§7.1). */
  resume(): void {
    if (!this.run || this.run.finalStatus) return;
    if (this.resumeWaiter) {
      this.resumeWaiter();
      return;
    }
    // Restored-after-SW-restart run: state exists but no loop coroutine.
    if (!this.loopRunning && this.run.phase === 'paused') {
      void this.ensureOverlay();
      void this.loop();
    }
  }

  /** User stop — overlay button or panel (§6.6). */
  stop(): void {
    if (!this.run || this.run.finalStatus) return;
    this.stopRequested = { status: 'stopped_by_user' };
    if (this.resumeWaiter) {
      this.resumeWaiter();
      return;
    }
    // Paused restored run with no loop: finalize inline.
    if (!this.loopRunning) void this.finalize('stopped_by_user');
  }

  /** Trusted human input during a run pauses it — never kills it (§6.6). */
  userIntervened(): void {
    this.pause('user_intervened');
  }

  /** Confirmation verdicts arrive in M4; the M2 guard never requests one. */
  confirm(_approved: boolean, _note?: string): void {
    this.deps.log('auto: AUTO_CONFIRMATION received but confirm mode lands in M4; ignored');
  }

  /**
   * webNavigation.onCommitted for the run's tab (§7.4): leaving the allowed
   * origins pauses the run; the loop never drives a non-allowlisted origin.
   */
  handleNavigationCommitted(tabId: number, url: string): void {
    if (!this.isActive() || this.run!.tabId !== tabId) return;
    if (!isOriginAllowed(url, this.run!.config)) {
      this.pause(`left_allowed_origin: ${url}`);
      if (this.resumeWaiter === null && !this.loopRunning) void this.persistAndPush();
    }
  }

  /**
   * Rehydrate a persisted run after an MV3 SW restart (§7.1): a run found
   * `running` becomes `paused` with detail 'service_worker_restarted' and a
   * Resume button — no transparent auto-resume in v1. A run that was already
   * paused keeps its original pause detail.
   */
  async restore(persisted: PersistedAutoRun): Promise<void> {
    this.run = {
      runId: persisted.runId,
      tabId: persisted.tabId,
      sessionId: persisted.sessionId,
      config: persisted.config,
      goal: persisted.config.goal,
      phase: 'paused',
      detail:
        persisted.status === 'paused'
          ? (persisted.detail ?? 'paused')
          : 'service_worker_restarted',
      trace: persisted.trace,
      history: persisted.historyCompact,
      stepsUsed: persisted.budgets.stepsUsed,
      llmCalls: persisted.budgets.llmCalls,
      startedAt: persisted.budgets.startedAt,
      staleEpochRetries: persisted.budgets.staleEpochRetries,
      correctionTurns: persisted.budgets.correctionTurns ?? 0,
    };
    await this.persistAndPush();
  }

  getState(): AutoStateMsg | null {
    return this.run ? this.stateMsg() : null;
  }

  // --- state machine internals ----------------------------------------------

  private async transition(phase: RunPhase, detail?: string): Promise<void> {
    if (!this.run) return;
    this.run.phase = phase;
    this.run.detail = detail;
    await this.persistAndPush();
  }

  /** Persist after EVERY transition (§7.1) and push AUTO_STATE to the panel. */
  private async persistAndPush(): Promise<void> {
    if (!this.run) return;
    await this.deps.persist(this.persisted()).catch(() => {});
    this.deps.pushState(this.stateMsg());
  }

  private statusOf(run: RunInternal): RunStatus {
    if (run.finalStatus) return run.finalStatus;
    if (run.phase === 'paused') return 'paused';
    if (run.phase === 'awaiting_confirmation') return 'awaiting_confirmation';
    if (run.phase === 'idle') return 'idle';
    return 'running';
  }

  private budgets(run: RunInternal): BudgetSnapshot {
    return {
      stepsUsed: run.stepsUsed,
      maxSteps: run.config.maxSteps,
      llmCalls: run.llmCalls,
      maxLlmCalls: run.config.maxLlmCalls,
      elapsedMs: this.deps.now() - run.startedAt,
      maxWallClockMs: run.config.maxWallClockMs,
      staleEpochRetries: run.staleEpochRetries,
      correctionTurns: run.correctionTurns,
    };
  }

  private stateMsg(): AutoStateMsg {
    const run = this.run!;
    return {
      type: 'AUTO_STATE',
      runId: run.runId,
      status: this.statusOf(run),
      phase: run.phase,
      ...(run.detail !== undefined && { detail: run.detail }),
      trace: run.trace,
      budgets: this.budgets(run),
      ...(run.outcome !== undefined && { outcome: run.outcome }),
      ...(run.reason !== undefined && { reason: run.reason }),
    };
  }

  private persisted(): PersistedAutoRun {
    const run = this.run!;
    return {
      runId: run.runId,
      config: run.config,
      tabId: run.tabId,
      sessionId: run.sessionId,
      status: this.statusOf(run),
      phase: run.phase,
      ...(run.detail !== undefined && { detail: run.detail }),
      trace: run.trace,
      historyCompact: run.history,
      budgets: {
        stepsUsed: run.stepsUsed,
        llmCalls: run.llmCalls,
        startedAt: run.startedAt,
        staleEpochRetries: run.staleEpochRetries,
        correctionTurns: run.correctionTurns,
      },
      ...(run.outcome !== undefined && { outcome: run.outcome }),
      ...(run.reason !== undefined && { reason: run.reason }),
    };
  }

  // --- the loop (§7.2) --------------------------------------------------------

  private async loop(): Promise<void> {
    if (this.loopRunning) return;
    this.loopRunning = true;
    try {
      while (this.run && !this.run.finalStatus) {
        if (await this.controlPoint()) return;

        await this.transition('observing');
        const bundle = await this.observeWithHandshake();
        if (await this.controlPoint()) return;
        if (!bundle) {
          await this.finalize('error', 'content script unreachable');
          return;
        }

        // Never drive actions on a non-allowlisted origin (§7.4).
        if (!isOriginAllowed(bundle.observation.url, this.run.config)) {
          this.pauseRequested = `left_allowed_origin: ${bundle.observation.url}`;
          continue;
        }

        // A navigation replaced the document (and the pill); restore it.
        if (bundle.observation.navigationOccurred) this.overlayVisible = false;
        await this.ensureOverlay();

        // The observation drains the buffers filled DURING the previous step —
        // backfill that step's trace/history evidence (§6.5 drain semantics).
        this.backfill(bundle.observation);

        const exhausted = this.checkBudgets();
        if (exhausted) {
          await this.finalize('stopped_by_budget', exhausted);
          return;
        }

        const outcome = await this.runStep(bundle);
        if (outcome === 'finalized') return;
      }
    } catch (err) {
      await this.finalize('error', err instanceof Error ? err.message : String(err));
    } finally {
      this.loopRunning = false;
    }
  }

  /**
   * Pause/stop checkpoint between async operations. `paused` is reachable
   * from any active state; the loop re-enters at `observing` after resume.
   * Returns true when the run finalized.
   */
  private async controlPoint(): Promise<boolean> {
    while (this.run && !this.run.finalStatus) {
      if (this.stopRequested) {
        const { status, detail } = this.stopRequested;
        this.stopRequested = null;
        await this.finalize(status, detail);
        return true;
      }
      if (this.pauseRequested !== null) {
        const detail = this.pauseRequested;
        this.pauseRequested = null;
        await this.transition('paused', detail);
        // Hide the pill while paused so trusted input doesn't re-signal
        // intervention; re-shown on resume (§6.6).
        await this.hideOverlay();
        await new Promise<void>((resolve) => {
          this.resumeWaiter = resolve;
        });
        this.resumeWaiter = null;
        this.resumeCount += 1;
        if (this.stopRequested) continue;
        await this.ensureOverlay();
        continue;
      }
      return false;
    }
    return true;
  }

  /** Budget checks run every iteration (§9.6); exhaustion keeps the partial trace. */
  private checkBudgets(): string | null {
    const run = this.run!;
    if (run.stepsUsed >= run.config.maxSteps) return 'max steps reached';
    if (this.deps.now() - run.startedAt >= run.config.maxWallClockMs) return 'wall clock exceeded';
    if (run.llmCalls >= run.config.maxLlmCalls) return 'max LLM calls reached';
    return null;
  }

  /**
   * Observe with handshake (§7.2, §7.4): on no-response, re-inject the
   * content script and retry with backoff for up to 5 s.
   */
  private async observeWithHandshake(): Promise<ObserveBundle | null> {
    const run = this.run!;
    const deadline = this.deps.now() + HANDSHAKE_TIMEOUT_MS;
    let injected = false;
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.deps.observe(run.tabId, run.runId, run.sessionId);
        if (response.ok) return { observation: response.observation, elements: response.elements };
        this.deps.log(`auto: observe failed: ${response.error}`);
        return null;
      } catch {
        if (!injected) {
          injected = true;
          await this.deps.injectContentScript(run.tabId).catch(() => {});
        }
        if (this.deps.now() >= deadline) return null;
        await this.deps.sleep(
          HANDSHAKE_BACKOFF_MS[Math.min(attempt, HANDSHAKE_BACKOFF_MS.length - 1)]!,
        );
      }
    }
  }

  /** One step: decide → guard → execute → record (§7.2). */
  private async runStep(initial: ObserveBundle): Promise<'continue' | 'finalized'> {
    const run = this.run!;
    let { observation, elements } = initial;
    const startedAt = this.deps.now();

    // Stale-epoch re-observe/re-decide happens at most once per step and
    // does not consume a step (§7.2).
    for (let attempt = 0; ; attempt++) {
      await this.transition('deciding');
      const decided = await this.decideWithCorrections(observation);
      if (decided.kind === 'finalized') return 'finalized';
      if (decided.kind === 'abandoned') return 'continue';
      if (decided.kind === 'invalid') {
        // Correction turns exhausted (§8.5): record the step as failed and
        // continue with a fresh observation on the next loop iteration.
        await this.recordStep(
          decided.candidate,
          'failed',
          'model_output_invalid',
          undefined,
          observation,
          startedAt,
        );
        return 'continue';
      }
      const action = decided.action;

      await this.transition('guarding');
      const verdict = checkAction(action, elements, run.config);
      if (verdict.verdict !== 'allow') {
        // M2 has no confirmation flow; a `confirm` verdict cannot occur (§14).
        await this.recordStep(action, 'refused', verdict.reason, undefined, observation, startedAt);
        return 'continue';
      }

      await this.transition('executing');
      let result: AutoExecuteResponse;
      try {
        result = await this.deps.execute(run.tabId, run.runId, observation.epoch, action);
      } catch (err) {
        // A hard navigation tears the content script down before it can
        // respond — the channel closes and the ActionResult is lost. Confirm
        // via the tab URL and treat it as a navigated success (§7.4).
        await this.deps.waitForTabLoad(run.tabId, TAB_LOAD_TIMEOUT_MS).catch(() => {});
        const url = await this.deps.getTabUrl(run.tabId).catch(() => null);
        if (url && url !== observation.url) {
          result = { ok: true, settled: false, navigated: true };
        } else {
          await this.finalize(
            'error',
            `execute: ${err instanceof Error ? err.message : String(err)}`,
          );
          return 'finalized';
        }
      }
      if (await this.controlPoint()) return 'finalized';

      if (!result.ok && result.reason === 'stale_epoch' && attempt === 0) {
        run.staleEpochRetries += 1;
        await this.transition('observing');
        const fresh = await this.observeWithHandshake();
        if (!fresh) {
          await this.finalize('error', 'content script unreachable');
          return 'finalized';
        }
        ({ observation, elements } = fresh);
        continue;
      }

      await this.transition('post_step');
      const resultKind = result.ok ? 'ok' : 'failed';
      const detail = result.ok
        ? undefined
        : [result.reason, result.detail].filter(Boolean).join(': ') || 'failed';
      await this.recordStep(action, resultKind, detail, result, observation, startedAt);

      if (action.type === 'finish') {
        run.outcome = action.outcome;
        run.reason = action.reason;
        await this.finalize('finished');
        return 'finalized';
      }

      if (result.navigated) await this.afterNavigation();
      return 'continue';
    }
  }

  /**
   * Decide phase with correction turns (§8.5): a server 422
   * (DeciderValidationError) or a failed SW-side re-validation re-POSTs the
   * SAME StepRequest plus a correction note — at most twice per step, counted
   * against maxLlmCalls, never maxSteps. Pause/stop mid-decide abandons the
   * step (and any correction sequence) cleanly; resume re-observes.
   */
  private async decideWithCorrections(
    observation: Observation,
  ): Promise<
    | { kind: 'action'; action: Action }
    | { kind: 'invalid'; candidate: Action }
    | { kind: 'abandoned' }
    | { kind: 'finalized' }
  > {
    const run = this.run!;
    let correction: string | undefined;
    let lastCandidate: unknown;
    let transportRetried = false;
    for (let corrections = 0; ; ) {
      const resumesBefore = this.resumeCount;
      let response: StepResponse | null = null;
      let invalidDetail: string | null = null;
      try {
        response = await this.deps.decide(
          this.deciderBaseUrl(),
          this.stepRequest(observation, correction),
        );
      } catch (err) {
        if (err instanceof DeciderValidationError) {
          invalidDetail = err.detail;
          lastCandidate = undefined;
        } else if (!transportRetried) {
          // A single provider hiccup (502/504/network) must not kill the run:
          // retry once per step, still counted against maxLlmCalls.
          transportRetried = true;
          run.llmCalls += 1;
          this.deps.log(
            `auto: decider failed, retrying once: ${err instanceof Error ? err.message : String(err)}`,
          );
          if (await this.controlPoint()) return { kind: 'finalized' };
          if (this.resumeCount !== resumesBefore) return { kind: 'abandoned' };
          await this.deps.sleep(DECIDER_RETRY_BACKOFF_MS);
          continue;
        } else {
          await this.finalize(
            'error',
            `decider: ${err instanceof Error ? err.message : String(err)}`,
          );
          return { kind: 'finalized' };
        }
      }
      run.llmCalls += 1;
      if (await this.controlPoint()) return { kind: 'finalized' };
      // Paused between decide and execute: the decision targets a page the
      // human may have changed — abandon the step; resume re-observes (§7.1).
      if (this.resumeCount !== resumesBefore) return { kind: 'abandoned' };

      if (response) {
        // Defensive re-validation in the SW (§5).
        const parsed = zAction.safeParse(response.action);
        if (parsed.success) return { kind: 'action', action: parsed.data };
        lastCandidate = response.action;
        invalidDetail = formatActionIssues(response.action, parsed.error);
      }

      if (corrections >= MAX_CORRECTIONS_PER_STEP) {
        return { kind: 'invalid', candidate: normalizeInvalidCandidate(lastCandidate) };
      }
      corrections += 1;
      run.correctionTurns += 1;
      correction = (invalidDetail ?? 'invalid output').slice(0, 500);
      this.deps.log(`auto: correction turn ${corrections}: ${correction}`);
    }
  }

  /** Append TraceStep + HistoryEntry; every recorded step consumes the counter. */
  private async recordStep(
    action: Action,
    result: HistoryEntry['result'],
    resultDetail: string | undefined,
    exec: AutoExecuteResponse | undefined,
    observation: Observation,
    startedAt: number,
  ): Promise<void> {
    const run = this.run!;
    run.stepsUsed += 1;
    const urlAfter = (await this.deps.getTabUrl(run.tabId).catch(() => null)) ?? observation.url;
    run.trace.push({
      step: run.stepsUsed,
      ...('intent' in action && action.intent !== undefined && { intent: action.intent }),
      action,
      result,
      ...(resultDetail !== undefined && { resultDetail: resultDetail.slice(0, 200) }),
      ...(exec?.durableSelector !== undefined && { durableSelector: exec.durableSelector }),
      ...(exec?.elementText !== undefined && { elementText: exec.elementText }),
      urlBefore: observation.url,
      urlAfter,
      consoleErrors: [],
      failedRequests: [],
      startedAt,
      endedAt: this.deps.now(),
    });
    run.history.push({
      step: run.stepsUsed,
      action,
      result,
      ...(resultDetail !== undefined && { resultDetail: resultDetail.slice(0, 200) }),
      urlAfter,
      newErrors: 0,
    });
    await this.persistAndPush();
  }

  /** Console/network evidence for step N arrives with observation N+1 (§6.5). */
  private backfill(observation: Observation): void {
    const run = this.run!;
    const lastTrace = run.trace[run.trace.length - 1];
    if (lastTrace) {
      lastTrace.consoleErrors = observation.consoleErrors;
      lastTrace.failedRequests = observation.failedRequests;
    }
    const lastHistory = run.history[run.history.length - 1];
    if (lastHistory) lastHistory.newErrors = observation.consoleErrors.length;
  }

  private stepRequest(observation: Observation, correction?: string): StepRequest {
    const run = this.run!;
    return {
      goal: run.goal,
      mode: run.config.mode,
      // Deterministic compression (§7.5): >20 entries → last 12 verbatim +
      // one synthetic line per 5 older steps.
      history: compressHistory(run.history),
      observation,
      stepsRemaining: run.config.maxSteps - run.stepsUsed,
      // Credential vault lands in M4 (§9.4); no placeholder names yet.
      placeholders: [],
      ...(correction !== undefined && { correction }),
    };
  }

  private deciderBaseUrl(): string {
    return this.run!.config.deciderBaseUrl ?? '';
  }

  /** The stop pill lives in the page; show it at most once per document (§6.6). */
  private async ensureOverlay(): Promise<void> {
    if (!this.run || this.overlayVisible) return;
    try {
      await this.deps.showOverlay(this.run.tabId, this.run.runId);
      this.overlayVisible = true;
    } catch {
      // Content script not ready yet — the next observe/ensure retries.
    }
  }

  private async hideOverlay(): Promise<void> {
    if (!this.run) return;
    this.overlayVisible = false;
    await this.deps.hideOverlay(this.run.tabId, this.run.runId).catch(() => {});
  }

  /** Navigation handling (§7.4): wait for load, then origin containment. */
  private async afterNavigation(): Promise<void> {
    const run = this.run!;
    this.overlayVisible = false;
    await this.deps.waitForTabLoad(run.tabId, TAB_LOAD_TIMEOUT_MS).catch(() => {});
    const url = await this.deps.getTabUrl(run.tabId).catch(() => null);
    if (url && !isOriginAllowed(url, run.config)) {
      this.pauseRequested = `left_allowed_origin: ${url}`;
    }
    // Re-handshake happens in the next loop iteration's observeWithHandshake.
  }

  private async finalize(status: RunStatus, detail?: string): Promise<void> {
    const run = this.run;
    if (!run || run.finalStatus) return;
    await this.transition('finalizing', detail);
    run.finalStatus = status;
    await this.deps.stopRecordingSession(run.tabId).catch(() => {});
    await this.hideOverlay();
    await this.transition('done', detail);
  }
}

/** Compact issue list for a correction note, e.g. `type 'click': index: Required`. */
function formatActionIssues(candidate: unknown, error: import('zod').ZodError): string {
  const type =
    candidate !== null && typeof candidate === 'object'
      ? (candidate as { type?: unknown }).type
      : undefined;
  const typeLabel = typeof type === 'string' ? `type '${type}': ` : '';
  const issues = error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || 'action'}: ${issue.message}`)
    .join('; ');
  return `${typeLabel}${issues}`;
}

/**
 * History records what happened, including invalid model output (§8.5) — the
 * shared zHistoryEntry tolerates any `{type: string}` shape. Normalize
 * unusable candidates so the record always carries a type.
 */
function normalizeInvalidCandidate(candidate: unknown): Action {
  const usable =
    candidate !== null &&
    typeof candidate === 'object' &&
    typeof (candidate as { type?: unknown }).type === 'string';
  return (usable ? candidate : { type: 'invalid_output' }) as Action;
}

/** Apply §5.4 defaults and the hard cap. */
export function clampConfig(config: RunConfig): RunConfig {
  const maxSteps = Math.min(config.maxSteps || RUN_DEFAULTS.maxSteps, RUN_DEFAULTS.maxStepsHardCap);
  return {
    ...config,
    maxSteps,
    maxWallClockMs: config.maxWallClockMs || RUN_DEFAULTS.maxWallClockMs,
    maxLlmCalls: config.maxLlmCalls || maxSteps + 10,
  };
}

export function isFinalStatus(status: RunStatus): boolean {
  return FINAL_STATUSES.includes(status);
}
