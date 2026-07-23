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
  HistoryItem,
  Observation,
  ObservedElement,
  RunConfig,
  RunResult,
  RunStatus,
  StepRequest,
  StepResponse,
  TraceStep,
} from '@qa-copilot/shared/auto';
import { RUN_DEFAULTS, zAction } from '@qa-copilot/shared/auto';
import { checkAction, isOriginAllowed, substituteCredentials } from './guard.js';
import { compressHistory } from './history.js';
import type {
  AutoExecuteResponse,
  AutoObserveResponse,
  AutoStateMsg,
  BudgetSnapshot,
  PendingConfirmation,
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
  /**
   * Credential vault (§9.4): name → value from chrome.storage.session. Values
   * stay inside the SW; only names ever reach a StepRequest, and only the
   * substituted AUTO_EXECUTE payload carries a real value.
   */
  readVault(): Promise<Record<string, string>>;
  /** Persist the finalized RunResult with the recorder session (§5.4, §10). */
  saveRunResult(result: RunResult): Promise<void>;
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
/** Side-panel confirmation window; expiry counts as rejection (§9.3). */
const CONFIRMATION_TIMEOUT_MS = 120_000;
/** Loop detection (§9.5): same action hash 3× → nudge, 5× → finalize. */
const LOOP_NUDGE_AT = 3;
const LOOP_FINALIZE_AT = 5;
const FAIL_NUDGE_AT = 3;
const LOOP_NUDGE =
  'note: you have repeated this action 3 times without progress; try a different approach or finish(blocked)';
const FAIL_NUDGE =
  'note: your last 3 actions failed; try a different approach or finish(blocked)';

const FINAL_STATUSES: readonly RunStatus[] = [
  'finished',
  'stopped_by_user',
  'stopped_by_budget',
  'error',
];

/** Rolling loop-detection state (§9.5); persisted so restarts keep counting. */
interface LoopState {
  lastActionHash: string | null;
  actionStreak: number;
  failStreak: number;
  /** Injected into the next StepRequest's history as a synthetic note line. */
  pendingNudge?: string;
}

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
  loop: LoopState;
  /** Set while phase is awaiting_confirmation; mirrored into AUTO_STATE. */
  pendingConfirmation?: PendingConfirmation;
  finalStatus?: RunStatus;
  outcome?: 'pass' | 'fail' | 'blocked';
  reason?: string;
}

/** The side-panel verdict the confirmation wait resolves with (§9.3). */
type ConfirmationOutcome = { approved: boolean; note?: string } | 'timeout' | 'interrupted';

interface ObserveBundle {
  observation: Observation;
  elements: ObservedElement[];
}

let runCounter = 0;

export class RunController {
  private run: RunInternal | null = null;
  private loopRunning = false;
  private resumeWaiter: (() => void) | null = null;
  /** Pending side-panel confirmation (§9.3); pause/stop interrupt it. */
  private confirmationWaiter: ((outcome: ConfirmationOutcome) => void) | null = null;
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
      loop: { lastActionHash: null, actionStreak: 0, failStreak: 0 },
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
    // A pending confirmation cannot outlive the pause: the step is abandoned
    // (the page may change under the human); resume re-observes (§7.1).
    this.confirmationWaiter?.('interrupted');
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
    this.confirmationWaiter?.('interrupted');
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

  /**
   * The tab hosting the run was closed (wiring: tabs.onRemoved). The run can
   * never continue — end it as an error like the other unreachable-tab paths,
   * instead of leaving it active forever (a paused run had no timeout that
   * would ever finalize it, blocking every new start()).
   */
  tabClosed(tabId: number): void {
    if (!this.run || this.run.finalStatus || this.run.tabId !== tabId) return;
    this.stopRequested = { status: 'error', detail: 'tab closed' };
    this.confirmationWaiter?.('interrupted');
    if (this.resumeWaiter) {
      this.resumeWaiter();
      return;
    }
    // Paused restored run with no loop: finalize inline.
    if (!this.loopRunning) void this.finalize('error', 'tab closed');
  }

  /**
   * Side-panel confirmation verdict (§9.3). Verdicts arriving with no pending
   * confirmation (already timed out, paused, or a stale panel) are logged and
   * ignored — stale-runId verdicts never reach here (wiring gates on runId).
   */
  confirm(approved: boolean, note?: string): void {
    if (this.confirmationWaiter) {
      this.confirmationWaiter({ approved, ...(note !== undefined && { note }) });
    } else {
      this.deps.log('auto: AUTO_CONFIRMATION with no pending confirmation; ignored');
    }
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
      loop: persisted.loop ?? { lastActionHash: null, actionStreak: 0, failStreak: 0 },
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
      ...(run.pendingConfirmation !== undefined && {
        pendingConfirmation: run.pendingConfirmation,
      }),
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
      loop: run.loop,
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

  /** One step: decide → guard → (confirm) → execute → record (§7.2, §9.3). */
  private async runStep(initial: ObserveBundle): Promise<'continue' | 'finalized'> {
    const run = this.run!;
    let { observation, elements } = initial;
    const startedAt = this.deps.now();
    // Vault read once per step (§9.4): names go into the StepRequest and the
    // guard; values only ever into the substituted AUTO_EXECUTE payload.
    const vault = await this.deps.readVault().catch(() => ({}) as Record<string, string>);
    const vaultNames = Object.keys(vault);

    // Stale-epoch re-observe/re-decide happens at most once per step and
    // does not consume a step (§7.2).
    for (let attempt = 0; ; attempt++) {
      await this.transition('deciding');
      const decided = await this.decideWithCorrections(observation, vaultNames);
      if (decided.kind === 'finalized') return 'finalized';
      if (decided.kind === 'abandoned') return 'continue';
      if (decided.kind === 'invalid') {
        // Correction turns exhausted (§8.5): record the step as failed and
        // continue with a fresh observation on the next loop iteration.
        return this.recordStep(
          decided.candidate,
          'failed',
          'model_output_invalid',
          undefined,
          observation,
          startedAt,
        );
      }
      const action = decided.action;

      await this.transition('guarding');
      const verdict = checkAction(action, elements, run.config, vaultNames);
      if (verdict.verdict === 'refuse') {
        return this.recordStep(action, 'refused', verdict.reason, undefined, observation, startedAt);
      }
      const destructive = verdict.destructive === true;

      let confirmedByUser = false;
      if (verdict.verdict === 'confirm') {
        const outcome = await this.awaitConfirmation(action, elements, verdict.reason);
        if (outcome === 'interrupted') {
          // Pause/stop arrived while awaiting: the step is abandoned without
          // consuming the counter; resume re-observes (§7.1).
          return (await this.controlPoint()) ? 'finalized' : 'continue';
        }
        if (outcome === 'timeout' || !outcome.approved) {
          const detail =
            outcome === 'timeout'
              ? 'confirmation timed out (120s)'
              : outcome.note
                ? `rejected: ${outcome.note}`
                : 'rejected by user';
          return this.recordStep(
            action,
            'rejected_by_user',
            detail,
            undefined,
            observation,
            startedAt,
            { destructive },
          );
        }
        confirmedByUser = true;
      }

      await this.transition('executing');
      let result: AutoExecuteResponse;
      try {
        result = await this.deps.execute(
          run.tabId,
          run.runId,
          observation.epoch,
          // Real credential values exist only in this payload (§9.4).
          substituteCredentials(action, vault),
        );
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
      const resultKind = result.ok ? (confirmedByUser ? 'confirmed_by_user' : 'ok') : 'failed';
      const detail = result.ok
        ? undefined
        : [result.reason, result.detail].filter(Boolean).join(': ') || 'failed';
      const stepOutcome = await this.recordStep(
        action,
        resultKind,
        detail,
        result,
        observation,
        startedAt,
        { destructive },
      );

      if (action.type === 'finish') {
        run.outcome = action.outcome;
        run.reason = action.reason;
        await this.finalize('finished');
        return 'finalized';
      }
      if (stepOutcome === 'finalized') return 'finalized';

      if (result.navigated) await this.afterNavigation();
      return 'continue';
    }
  }

  /**
   * Confirmation wait (§9.3): surface the pending action to the panel, then
   * race the AUTO_CONFIRMATION verdict against the 120 s timeout. Pause/stop
   * resolve the wait with 'interrupted'.
   */
  private async awaitConfirmation(
    action: Action,
    elements: ObservedElement[],
    reason: string,
  ): Promise<ConfirmationOutcome> {
    const run = this.run!;
    const element =
      'index' in action ? elements.find((e) => e.index === action.index) : undefined;
    const requestedAt = this.deps.now();
    run.pendingConfirmation = {
      action,
      ...(element?.text && { elementText: element.text }),
      reason,
      requestedAt,
      expiresAt: requestedAt + CONFIRMATION_TIMEOUT_MS,
    };
    await this.transition('awaiting_confirmation', reason);

    const outcome = await new Promise<ConfirmationOutcome>((resolve) => {
      this.confirmationWaiter = resolve;
      void this.deps.sleep(CONFIRMATION_TIMEOUT_MS).then(() => resolve('timeout'));
    });
    this.confirmationWaiter = null;
    run.pendingConfirmation = undefined;
    return outcome;
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
    vaultNames: string[],
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
          this.stepRequest(observation, vaultNames, correction),
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

  /**
   * Append TraceStep + HistoryEntry; every recorded step consumes the counter
   * and feeds loop detection (§9.5). Returns 'finalized' when the same action
   * hash reached 5× and the run ended as stopped_by_budget ('action loop').
   */
  private async recordStep(
    action: Action,
    result: HistoryEntry['result'],
    resultDetail: string | undefined,
    exec: AutoExecuteResponse | undefined,
    observation: Observation,
    startedAt: number,
    opts: { destructive?: boolean } = {},
  ): Promise<'continue' | 'finalized'> {
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
      ...(opts.destructive === true && { destructive: true }),
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

    // Loop detection (§9.5). `finish` finalizes anyway and never loops.
    const loop = run.loop;
    loop.pendingNudge = undefined;
    if (action.type !== 'finish') {
      const hash = actionHash(action, urlAfter);
      if (hash === loop.lastActionHash) {
        loop.actionStreak += 1;
      } else {
        loop.lastActionHash = hash;
        loop.actionStreak = 1;
      }
      loop.failStreak = result === 'failed' ? loop.failStreak + 1 : 0;
      if (loop.actionStreak >= LOOP_FINALIZE_AT) {
        await this.finalize('stopped_by_budget', 'action loop');
        return 'finalized';
      }
      if (loop.actionStreak === LOOP_NUDGE_AT) loop.pendingNudge = LOOP_NUDGE;
      else if (loop.failStreak === FAIL_NUDGE_AT) loop.pendingNudge = FAIL_NUDGE;
    }

    await this.persistAndPush();
    return 'continue';
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

  private stepRequest(
    observation: Observation,
    vaultNames: string[],
    correction?: string,
  ): StepRequest {
    const run = this.run!;
    // Deterministic compression (§7.5): >20 entries → last 12 verbatim +
    // one synthetic line per 5 older steps.
    const history: HistoryItem[] = compressHistory(run.history);
    // Loop-detection nudge (§9.5): injected as a synthetic note line for the
    // step(s) following the streak; correction turns re-send it unchanged.
    if (run.loop.pendingNudge) {
      const lastStep = run.history[run.history.length - 1]?.step ?? 0;
      history.push({
        kind: 'summary',
        fromStep: lastStep,
        toStep: lastStep,
        line: run.loop.pendingNudge,
      });
    }
    return {
      goal: run.goal,
      mode: run.config.mode,
      history,
      observation,
      stepsRemaining: run.config.maxSteps - run.stepsUsed,
      // Names only — values never leave the SW (§9.4).
      placeholders: vaultNames,
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
    // Final status is assigned BEFORE the finalizing transition persists: a
    // SW suspension inside this method must never leave a `running` record
    // that the next wake would resurrect as paused (§7.1).
    run.finalStatus = status;
    await this.transition('finalizing', detail);
    await this.deps.stopRecordingSession(run.tabId).catch(() => {});
    // Defect & assertion plumbing (§5.4): the RunResult persists with the
    // recorder session so runs are reviewable after the fact (§10). Partial
    // runs (budget stops, errors) keep whatever the trace collected.
    await this.deps.saveRunResult(buildRunResult(run, status, this.deps.now())).catch(() => {});
    await this.hideOverlay();
    await this.transition('done', detail);
  }
}

/** Derive the persisted RunResult from the trace (§5.4), incl. metrics (§12). */
function buildRunResult(run: RunInternal, status: RunStatus, endedAt: number): RunResult {
  const defects: RunResult['defects'] = [];
  const assertions: RunResult['assertions'] = [];
  let refusals = 0;
  let confirmations = 0;
  for (const step of run.trace) {
    if (step.result === 'refused') refusals += 1;
    if (step.result === 'confirmed_by_user' || step.result === 'rejected_by_user') {
      confirmations += 1;
    }
    if (step.result !== 'ok' && step.result !== 'confirmed_by_user') continue;
    if (step.action.type === 'report_defect') defects.push({ ...step.action, step: step.step });
    if (step.action.type === 'assert') assertions.push({ ...step.action, step: step.step });
  }
  return {
    status,
    ...(run.outcome !== undefined && { outcome: run.outcome }),
    ...(run.reason !== undefined && { reason: run.reason }),
    trace: run.trace,
    defects,
    assertions,
    metrics: {
      steps: run.stepsUsed,
      llmCalls: run.llmCalls,
      correctionTurns: run.correctionTurns,
      refusals,
      confirmations,
      wallClockMs: endedAt - run.startedAt,
    },
    sessionId: run.sessionId,
  };
}

/**
 * Rolling loop-detection hash (§9.5): (urlAfter, action.type, index?, salient
 * value). Direction/key/url are the "value" for non-element actions so paging
 * through a long document (down, down, …) counts as repetition only when
 * genuinely identical.
 */
function actionHash(action: Action, urlAfter: string): string {
  const index = 'index' in action ? action.index : null;
  const value = (() => {
    switch (action.type) {
      case 'fill':
        return action.value;
      case 'select':
        return action.option;
      case 'press':
        return action.key;
      case 'scroll':
        return `${action.direction}:${action.amount}`;
      case 'navigate':
        return action.url;
      case 'wait':
        return String(action.seconds);
      case 'assert':
        return action.expectation;
      case 'report_defect':
        return action.summary;
      default:
        return null;
    }
  })();
  return JSON.stringify([urlAfter, action.type, index, value]);
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
