/**
 * Run-controller unit suite (tasks 9.4 / 10.7 / 11.3 / 12.4): the whole
 * machine runs against fake deps — no chrome, no DOM. Scenario scripting:
 * queue decider responses and executor results, then await the final pushed
 * AUTO_STATE.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  Action,
  HistoryEntry,
  Observation,
  RunConfig,
  RunResult,
  StepRequest,
  StepResponse,
} from '@qa-copilot/shared/auto';
import { checkAction } from './guard.js';
import type {
  AutoExecuteResponse,
  AutoObserveResponse,
  AutoStateMsg,
  PersistedAutoRun,
  RunPhase,
} from './messages.js';
import {
  clampConfig,
  DeciderValidationError,
  RunController,
  type RunControllerDeps,
} from './run-controller.js';

const ORIGIN = 'http://localhost:5555';

function makeConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    goal: 'explore the playground',
    mode: 'autonomous',
    maxSteps: 25,
    maxWallClockMs: 10 * 60 * 1000,
    maxLlmCalls: 35,
    originAllowlist: [ORIGIN],
    deciderBaseUrl: 'http://stub',
    ...overrides,
  };
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    url: `${ORIGIN}/auto-playground.html`,
    title: 'Playground',
    pageInfo: {
      viewportWidth: 1280,
      viewportHeight: 800,
      pageWidth: 1280,
      pageHeight: 800,
      pixelsAbove: 0,
      pixelsBelow: 0,
      scrollPositionPct: 0,
    },
    activeDialog: null,
    serialized: '[0]<button >Create item />',
    elementCount: 1,
    consoleErrors: [],
    failedRequests: [],
    navigationOccurred: false,
    timestamp: 0,
    epoch: 1,
    ...overrides,
  };
}

const CLICK: Action = { type: 'click', index: 0, intent: 'click the button' };
const FINISH: Action = { type: 'finish', outcome: 'pass', reason: 'goal reached' };

const OK: AutoExecuteResponse = {
  ok: true,
  settled: true,
  navigated: false,
  durableSelector: "getByRole('button', { name: 'Create item' })",
  elementText: 'Create item',
};

interface Harness {
  controller: RunController;
  deps: RunControllerDeps;
  states: AutoStateMsg[];
  persisted: PersistedAutoRun[];
  logs: string[];
  requests: StepRequest[];
  runResults: RunResult[];
  /** Mutable vault backing readVault (§9.4). */
  vault: Record<string, string>;
  observe: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  decide: ReturnType<typeof vi.fn>;
  inject: ReturnType<typeof vi.fn>;
  waitForTabLoad: ReturnType<typeof vi.fn>;
  getTabUrl: ReturnType<typeof vi.fn>;
  showOverlay: ReturnType<typeof vi.fn>;
  hideOverlay: ReturnType<typeof vi.fn>;
  stopRecording: ReturnType<typeof vi.fn>;
  clock: { t: number };
  /**
   * Sleeps ≥ 60 s (the confirmation timeout) are held instead of auto-advanced
   * so confirm-flow tests control the race; release fires them.
   */
  releaseLongSleeps(): void;
  lastState(): AutoStateMsg;
  phases(): RunPhase[];
  waitForStatus(status: string): Promise<AutoStateMsg>;
}

function makeHarness(): Harness {
  const states: AutoStateMsg[] = [];
  const persisted: PersistedAutoRun[] = [];
  const logs: string[] = [];
  const requests: StepRequest[] = [];
  const runResults: RunResult[] = [];
  const vault: Record<string, string> = {};
  const clock = { t: 0 };
  const longSleeps: Array<() => void> = [];

  const observe = vi.fn(
    async (): Promise<AutoObserveResponse> => ({
      ok: true,
      observation: makeObservation({ epoch: observe.mock.calls.length }),
      elements: [],
    }),
  );
  const execute = vi.fn(async (_action?: Action): Promise<AutoExecuteResponse> => OK);
  const decide = vi.fn(async (_request?: StepRequest): Promise<StepResponse> => ({
    action: FINISH,
  }));
  const inject = vi.fn(async () => true);
  const waitForTabLoad = vi.fn(async () => {});
  const getTabUrl = vi.fn(async () => `${ORIGIN}/auto-playground.html`);
  const showOverlay = vi.fn(async () => {});
  const hideOverlay = vi.fn(async () => {});
  const stopRecording = vi.fn(async () => {});

  const deps: RunControllerDeps = {
    observe: (_tabId, _runId, _sessionId) => observe(),
    execute: (_tabId, _runId, _epoch, action) => execute(action),
    showOverlay: () => showOverlay(),
    hideOverlay: () => hideOverlay(),
    injectContentScript: () => inject(),
    decide: (_baseUrl, request) => {
      requests.push(request);
      return decide(request);
    },
    getTabUrl: () => getTabUrl(),
    waitForTabLoad: () => waitForTabLoad(),
    startRecordingSession: async () => 'session_test',
    stopRecordingSession: () => stopRecording(),
    readVault: async () => ({ ...vault }),
    saveRunResult: async (result) => {
      runResults.push(JSON.parse(JSON.stringify(result)) as RunResult);
    },
    persist: async (state) => {
      persisted.push(JSON.parse(JSON.stringify(state)) as PersistedAutoRun);
    },
    pushState: (state) => {
      states.push(JSON.parse(JSON.stringify(state)) as AutoStateMsg);
    },
    log: (message) => {
      logs.push(message);
    },
    now: () => clock.t,
    sleep: async (ms) => {
      if (ms >= 60_000) {
        await new Promise<void>((resolve) => {
          longSleeps.push(resolve);
        });
        return;
      }
      clock.t += ms;
    },
  };

  const controller = new RunController(deps);
  return {
    controller,
    deps,
    states,
    persisted,
    logs,
    requests,
    runResults,
    vault,
    observe,
    execute,
    decide,
    inject,
    waitForTabLoad,
    getTabUrl,
    showOverlay,
    hideOverlay,
    stopRecording,
    clock,
    releaseLongSleeps: () => {
      for (const release of longSleeps.splice(0)) release();
    },
    lastState: () => states[states.length - 1]!,
    phases: () => states.map((s) => s.phase),
    waitForStatus: (status) =>
      vi.waitFor(() => {
        const last = states[states.length - 1];
        if (!last || last.status !== status) throw new Error(`status is ${last?.status}`);
        return last;
      }),
  };
}

/** Queue decider responses: last entry repeats forever. */
function scriptDecider(h: Harness, actions: Action[]): void {
  let call = 0;
  h.decide.mockImplementation(async () => ({
    action: actions[Math.min(call++, actions.length - 1)]!,
  }));
}

// --- 9.4 state machine -------------------------------------------------------

describe('state machine (9.4)', () => {
  it('walks starting → observing → deciding → guarding → executing → post_step → finalizing → done and pushes AUTO_STATE on every transition', async () => {
    const h = makeHarness();
    scriptDecider(h, [CLICK, FINISH]);
    await h.controller.start(makeConfig(), 1);
    const final = await h.waitForStatus('finished');

    const phases = h.phases();
    for (const expected of [
      'starting',
      'observing',
      'deciding',
      'guarding',
      'executing',
      'post_step',
      'finalizing',
      'done',
    ] as RunPhase[]) {
      expect(phases).toContain(expected);
    }
    // Every transition persisted AND pushed — same count, same order.
    expect(h.persisted.length).toBe(h.states.length);
    expect(final.outcome).toBe('pass');
  });

  it('drops and logs messages carrying a stale runId', async () => {
    const h = makeHarness();
    await h.controller.start(makeConfig(), 1);
    await h.waitForStatus('finished');
    expect(h.controller.acceptsRunId('run_bogus')).toBe(false);
    expect(h.logs.some((l) => l.includes('stale runId') && l.includes('run_bogus'))).toBe(true);
    expect(h.controller.acceptsRunId(h.lastState().runId)).toBe(true);
  });

  it('pause parks the run; resume always returns to observing with a fresh observation', async () => {
    const h = makeHarness();
    let releaseDecide!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDecide = resolve;
    });
    let call = 0;
    h.decide.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        await gate;
        return { action: CLICK };
      }
      return { action: FINISH };
    });

    await h.controller.start(makeConfig(), 1);
    await vi.waitFor(() => expect(call).toBe(1));
    const observesBeforePause = h.observe.mock.calls.length;

    h.controller.pause('paused_by_user');
    releaseDecide();
    await h.waitForStatus('paused');
    expect(h.lastState().detail).toBe('paused_by_user');

    h.controller.resume();
    await h.waitForStatus('finished');
    // The pre-pause decision was abandoned; the loop re-observed after resume.
    expect(h.observe.mock.calls.length).toBeGreaterThan(observesBeforePause);
    // The abandoned decision consumed no step: only the finish step recorded.
    expect(h.lastState().trace).toHaveLength(1);
  });

  it('rejects a second start while a run is active, and resume/pause outside a run are no-ops', async () => {
    const h = makeHarness();
    h.controller.pause('nope');
    h.controller.resume();
    expect(h.states).toHaveLength(0);

    let release!: () => void;
    h.decide.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { action: FINISH };
    });
    await h.controller.start(makeConfig(), 1);
    await expect(h.controller.start(makeConfig(), 1)).rejects.toThrow(/already active/);
    await vi.waitFor(() => expect(h.decide).toHaveBeenCalled());
    release();
    await h.waitForStatus('finished');
  });
});

// --- 10.x loop, budgets, guard -------------------------------------------------

describe('step loop and budgets (10.7)', () => {
  it('maxSteps exhaustion finalizes stopped_by_budget with the partial trace', async () => {
    const h = makeHarness();
    scriptDecider(h, [CLICK]);
    await h.controller.start(makeConfig({ maxSteps: 3 }), 1);
    const final = await h.waitForStatus('stopped_by_budget');
    expect(final.detail).toBe('max steps reached');
    expect(final.trace).toHaveLength(3);
  });

  it('maxWallClockMs exhaustion finalizes stopped_by_budget', async () => {
    const h = makeHarness();
    scriptDecider(h, [CLICK]);
    h.decide.mockImplementation(async () => {
      h.clock.t += 600;
      return { action: CLICK };
    });
    await h.controller.start(makeConfig({ maxWallClockMs: 1000 }), 1);
    const final = await h.waitForStatus('stopped_by_budget');
    expect(final.detail).toBe('wall clock exceeded');
    expect(final.trace.length).toBeGreaterThan(0);
  });

  it('maxLlmCalls exhaustion finalizes stopped_by_budget', async () => {
    const h = makeHarness();
    scriptDecider(h, [CLICK]);
    await h.controller.start(makeConfig({ maxLlmCalls: 2 }), 1);
    const final = await h.waitForStatus('stopped_by_budget');
    expect(final.detail).toBe('max LLM calls reached');
    expect(final.budgets.llmCalls).toBe(2);
  });

  it('stale_epoch triggers exactly one re-observe + re-decide without consuming a step', async () => {
    const h = makeHarness();
    scriptDecider(h, [CLICK, CLICK, FINISH]);
    h.execute
      .mockResolvedValueOnce({ ok: false, reason: 'stale_epoch', settled: true, navigated: false })
      .mockResolvedValue(OK);

    await h.controller.start(makeConfig(), 1);
    const final = await h.waitForStatus('finished');
    expect(final.budgets.staleEpochRetries).toBe(1);
    // Step 1 (click, retried once) + step 2 (finish): the retry consumed no step.
    expect(final.trace).toHaveLength(2);
    expect(final.trace[0]!.result).toBe('ok');
    // Two decides for step 1, one for step 2.
    expect(final.budgets.llmCalls).toBe(3);
  });

  it('a second stale_epoch in the same step records the step as failed', async () => {
    const h = makeHarness();
    scriptDecider(h, [CLICK, CLICK, FINISH]);
    h.execute
      .mockResolvedValueOnce({ ok: false, reason: 'stale_epoch', settled: true, navigated: false })
      .mockResolvedValueOnce({ ok: false, reason: 'stale_epoch', settled: true, navigated: false })
      .mockResolvedValue(OK);

    await h.controller.start(makeConfig(), 1);
    const final = await h.waitForStatus('finished');
    expect(final.trace[0]!.result).toBe('failed');
    expect(final.trace[0]!.resultDetail).toContain('stale_epoch');
    expect(final.budgets.staleEpochRetries).toBe(1);
  });

  it('carries the goal fixed at run start into every StepRequest', async () => {
    const h = makeHarness();
    scriptDecider(h, [CLICK, CLICK, FINISH]);
    await h.controller.start(makeConfig({ goal: 'THE GOAL' }), 1);
    await h.waitForStatus('finished');
    expect(h.requests.length).toBeGreaterThanOrEqual(3);
    for (const request of h.requests) expect(request.goal).toBe('THE GOAL');
  });

  it('finish finalizes with the model outcome and reason', async () => {
    const h = makeHarness();
    scriptDecider(h, [{ type: 'finish', outcome: 'blocked', reason: 'dead end' }]);
    await h.controller.start(makeConfig(), 1);
    const final = await h.waitForStatus('finished');
    expect(final.outcome).toBe('blocked');
    expect(final.reason).toBe('dead end');
    expect(h.stopRecording).toHaveBeenCalled();
    expect(h.hideOverlay).toHaveBeenCalled();
  });

  it('a guard refusal records HistoryEntry{refused} with the reason and consumes a step', async () => {
    const h = makeHarness();
    const offOrigin: Action = {
      type: 'navigate',
      url: 'https://evil.example/phish',
      intent: 'wander off',
    };
    scriptDecider(h, [offOrigin, FINISH]);
    await h.controller.start(makeConfig(), 1);
    const final = await h.waitForStatus('finished');

    expect(final.trace[0]!.result).toBe('refused');
    expect(final.trace[0]!.resultDetail).toBe('navigation outside allowed origin');
    expect(final.trace[0]!.step).toBe(1);
    // The refusal reason is model-visible: the next StepRequest's history has it.
    const lastRequest = h.requests[h.requests.length - 1]!;
    const refusedEntry = lastRequest.history[0] as HistoryEntry;
    expect(refusedEntry.result).toBe('refused');
    expect(refusedEntry.resultDetail).toBe('navigation outside allowed origin');
    // The refused navigate never reached the executor — only the finish did.
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('records an observe-only refusal as HistoryEntry{refused} visible to the model (§9.2)', async () => {
    const h = makeHarness();
    const fill: Action = { type: 'fill', index: 0, value: 'x', intent: 'type into the form' };
    scriptDecider(h, [fill, FINISH]);
    await h.controller.start(makeConfig({ mode: 'observe_only' }), 1);
    const final = await h.waitForStatus('finished');

    expect(final.trace[0]!.result).toBe('refused');
    expect(final.trace[0]!.resultDetail).toBe('observe-only mode');
    const refusedEntry = h.requests[h.requests.length - 1]!.history[0] as HistoryEntry;
    expect(refusedEntry.result).toBe('refused');
    expect(refusedEntry.resultDetail).toBe('observe-only mode');
    // The refused fill never reached the executor — only the finish did.
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('recovers from invalid output via a correction turn (§8.5)', async () => {
    const h = makeHarness();
    let call = 0;
    h.decide.mockImplementation(async () => {
      call += 1;
      return call === 1
        ? ({ action: { type: 'execute_js', code: 'alert(1)' } } as unknown as StepResponse)
        : { action: FINISH };
    });
    await h.controller.start(makeConfig(), 1);
    const final = await h.waitForStatus('finished');

    // The correction re-POSTs the SAME StepRequest plus the correction note.
    expect(h.requests).toHaveLength(2);
    expect(h.requests[0]!.correction).toBeUndefined();
    expect(h.requests[1]!.correction).toContain("type 'execute_js'");
    expect(h.requests[1]!.observation.epoch).toBe(h.requests[0]!.observation.epoch);

    // Correction consumed an LLM call but no step; no failed step recorded.
    expect(final.budgets.llmCalls).toBe(2);
    expect(final.budgets.correctionTurns).toBe(1);
    expect(final.budgets.stepsUsed).toBe(1);
    expect(final.trace).toHaveLength(1);
    expect(final.trace[0]!.action.type).toBe('finish');
  });

  it('a server 422 (DeciderValidationError) triggers a correction turn', async () => {
    const h = makeHarness();
    let call = 0;
    h.decide.mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new DeciderValidationError("type 'click': index: Required");
      return { action: FINISH };
    });
    await h.controller.start(makeConfig(), 1);
    const final = await h.waitForStatus('finished');
    expect(h.requests[1]!.correction).toBe("type 'click': index: Required");
    expect(final.budgets.correctionTurns).toBe(1);
    expect(final.status).toBe('finished');
  });

  it('gives up after 2 corrections and records failed (model_output_invalid), then re-observes', async () => {
    const h = makeHarness();
    let call = 0;
    h.decide.mockImplementation(async () => {
      call += 1;
      return call <= 3
        ? ({ action: { type: 'execute_js', code: 'alert(1)' } } as unknown as StepResponse)
        : { action: FINISH };
    });
    await h.controller.start(makeConfig(), 1);
    const final = await h.waitForStatus('finished');

    expect(final.trace[0]!.result).toBe('failed');
    expect(final.trace[0]!.resultDetail).toBe('model_output_invalid');
    // 1 attempt + 2 corrections for step 1, then the finish decision.
    expect(final.budgets.llmCalls).toBe(4);
    expect(final.budgets.correctionTurns).toBe(2);
    // The invalid action never reached the executor — only the finish did.
    expect(h.execute).toHaveBeenCalledTimes(1);
    // The failed step continued with a FRESH observation (§8.5).
    expect(h.observe.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(h.requests[3]!.observation.epoch).toBeGreaterThan(h.requests[0]!.observation.epoch);
    // The invalid output is model-visible in later history.
    const failedEntry = h.requests[3]!.history[0] as HistoryEntry;
    expect(failedEntry.result).toBe('failed');
    expect((failedEntry.action as { type: string }).type).toBe('execute_js');
  });

  it('corrections count against maxLlmCalls, not maxSteps', async () => {
    const h = makeHarness();
    h.decide.mockResolvedValue({
      action: { type: 'execute_js' },
    } as unknown as StepResponse);
    await h.controller.start(makeConfig({ maxLlmCalls: 2 }), 1);
    const final = await h.waitForStatus('stopped_by_budget');

    // One step burned 3 LLM calls (attempt + 2 corrections) but only 1 step.
    expect(final.budgets.stepsUsed).toBe(1);
    expect(final.budgets.llmCalls).toBe(3);
    expect(final.detail).toBe('max LLM calls reached');
  });

  it('abandons a correction sequence cleanly on pause mid-step, resuming with a fresh observation', async () => {
    const h = makeHarness();
    let call = 0;
    h.decide.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        // Invalid output AND the user pauses while the decide was in flight.
        h.controller.pause('paused_by_user');
        return { action: { type: 'execute_js' } } as unknown as StepResponse;
      }
      return { action: FINISH };
    });
    await h.controller.start(makeConfig(), 1);
    await h.waitForStatus('paused');

    // No correction POST fired while paused; no step was recorded.
    expect(h.requests).toHaveLength(1);
    expect(h.lastState().trace).toHaveLength(0);

    h.controller.resume();
    const final = await h.waitForStatus('finished');
    // The post-resume request is a fresh step: new observation, no correction.
    expect(h.requests[1]!.correction).toBeUndefined();
    expect(h.requests[1]!.observation.epoch).toBeGreaterThan(h.requests[0]!.observation.epoch);
    expect(final.budgets.stepsUsed).toBe(1);
  });

  it('retries once on a transient decider failure, then finalizes error on a second', async () => {
    const h = makeHarness();
    let call = 0;
    h.decide.mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new Error('decider HTTP 502');
      return { action: FINISH };
    });
    await h.controller.start(makeConfig(), 1);
    const final = await h.waitForStatus('finished');
    expect(final.budgets.llmCalls).toBe(2);
    expect(final.budgets.correctionTurns).toBe(0);

    // A second transport failure in the same step still finalizes the run.
    const h2 = makeHarness();
    h2.decide.mockRejectedValue(new Error('decider HTTP 502'));
    await h2.controller.start(makeConfig(), 1);
    const errored = await h2.waitForStatus('error');
    expect(errored.detail).toContain('decider HTTP 502');
    expect(errored.budgets.llmCalls).toBe(1);
  });

  it('finalizes immediately when stopped mid-correction', async () => {
    const h = makeHarness();
    h.decide.mockImplementation(async () => {
      h.controller.stop();
      return { action: { type: 'execute_js' } } as unknown as StepResponse;
    });
    await h.controller.start(makeConfig(), 1);
    const final = await h.waitForStatus('stopped_by_user');
    expect(h.requests).toHaveLength(1);
    expect(final.trace).toHaveLength(0);
  });

  it('backfills the previous step evidence from the next observation', async () => {
    const h = makeHarness();
    scriptDecider(h, [CLICK, FINISH]);
    h.observe
      .mockResolvedValueOnce({ ok: true, observation: makeObservation({ epoch: 1 }), elements: [] })
      .mockResolvedValue({
        ok: true,
        observation: makeObservation({
          epoch: 2,
          consoleErrors: ['TypeError: boom'],
          failedRequests: [{ method: 'POST', url: '/api/save', status: 500 }],
        }),
        elements: [],
      });
    await h.controller.start(makeConfig(), 1);
    const final = await h.waitForStatus('finished');
    expect(final.trace[0]!.consoleErrors).toEqual(['TypeError: boom']);
    expect(final.trace[0]!.failedRequests).toEqual([
      { method: 'POST', url: '/api/save', status: 500 },
    ]);
    const finishRequest = h.requests[h.requests.length - 1]!;
    expect((finishRequest.history[0] as HistoryEntry).newErrors).toBe(1);
  });
});

describe('guard scaffold', () => {
  it('origin-locks navigate and allows everything else in M2', () => {
    const config = makeConfig();
    expect(
      checkAction({ type: 'navigate', url: 'https://evil.example/x', intent: 'x' }, [], config),
    ).toEqual({ verdict: 'refuse', reason: 'navigation outside allowed origin' });
    expect(
      checkAction({ type: 'navigate', url: `${ORIGIN}/second.html`, intent: 'x' }, [], config),
    ).toEqual({ verdict: 'allow' });
    expect(checkAction(CLICK, [], config)).toEqual({ verdict: 'allow' });
  });
});

// --- 11.3 navigation -----------------------------------------------------------

describe('navigation handling (11.3)', () => {
  it('a navigated result waits for tab load and continues with a fresh observation', async () => {
    const h = makeHarness();
    scriptDecider(h, [CLICK, FINISH]);
    h.execute.mockResolvedValueOnce({ ...OK, navigated: true, settled: false }).mockResolvedValue(OK);
    await h.controller.start(makeConfig(), 1);
    const final = await h.waitForStatus('finished');
    expect(h.waitForTabLoad).toHaveBeenCalledTimes(1);
    expect(final.trace).toHaveLength(2);
    // Re-observed after the navigation for the finish step.
    expect(h.observe.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('re-injects the content script when observe gets no response, then retries', async () => {
    const h = makeHarness();
    h.observe
      .mockRejectedValueOnce(new Error('Receiving end does not exist'))
      .mockResolvedValue({ ok: true, observation: makeObservation(), elements: [] });
    await h.controller.start(makeConfig(), 1);
    await h.waitForStatus('finished');
    expect(h.inject).toHaveBeenCalledTimes(1);
    expect(h.observe.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('finalizes with an error when the content script stays unreachable past the handshake window', async () => {
    const h = makeHarness();
    h.observe.mockRejectedValue(new Error('Receiving end does not exist'));
    await h.controller.start(makeConfig(), 1);
    const final = await h.waitForStatus('error');
    expect(final.detail).toBe('content script unreachable');
    expect(h.inject).toHaveBeenCalled();
  });

  it('treats an execute channel-teardown as a navigated success when the tab URL changed', async () => {
    const h = makeHarness();
    scriptDecider(h, [CLICK, FINISH]);
    h.execute
      .mockRejectedValueOnce(new Error('message channel closed before a response was received'))
      .mockResolvedValue(OK);
    h.getTabUrl.mockResolvedValue(`${ORIGIN}/auto-second.html`);
    await h.controller.start(makeConfig(), 1);
    const final = await h.waitForStatus('finished');
    expect(final.trace[0]!.result).toBe('ok');
    expect(final.trace[0]!.urlAfter).toContain('auto-second.html');
    expect(h.waitForTabLoad).toHaveBeenCalled();
  });

  it('finalizes with an error when execute fails without a navigation', async () => {
    const h = makeHarness();
    scriptDecider(h, [CLICK, FINISH]);
    h.execute.mockRejectedValue(new Error('tab crashed'));
    await h.controller.start(makeConfig(), 1);
    const final = await h.waitForStatus('error');
    expect(final.detail).toContain('tab crashed');
  });

  it('pauses with left_allowed_origin when navigation lands off the allowlist', async () => {
    const h = makeHarness();
    scriptDecider(h, [CLICK, FINISH]);
    h.execute.mockResolvedValue({ ...OK, navigated: true, settled: false });
    h.getTabUrl.mockResolvedValue('https://accounts.oauth.example/login');
    await h.controller.start(makeConfig(), 1);
    const paused = await h.waitForStatus('paused');
    expect(paused.detail).toBe('left_allowed_origin: https://accounts.oauth.example/login');
    // No further actions on the foreign origin.
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('pauses when webNavigation commits an off-allowlist URL for the run tab', async () => {
    const h = makeHarness();
    let releaseDecide!: () => void;
    h.decide.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseDecide = resolve;
      });
      return { action: CLICK };
    });
    await h.controller.start(makeConfig(), 1);
    await vi.waitFor(() => expect(h.decide).toHaveBeenCalled());

    h.controller.handleNavigationCommitted(1, 'https://elsewhere.example/');
    h.controller.handleNavigationCommitted(99, 'https://ignored.example/'); // other tab: ignored
    releaseDecide();
    const paused = await h.waitForStatus('paused');
    expect(paused.detail).toBe('left_allowed_origin: https://elsewhere.example/');
  });

  it('observing an off-allowlist page pauses instead of driving it', async () => {
    const h = makeHarness();
    h.observe.mockResolvedValue({
      ok: true,
      observation: makeObservation({ url: 'https://elsewhere.example/page' }),
      elements: [],
    });
    await h.controller.start(makeConfig(), 1);
    const paused = await h.waitForStatus('paused');
    expect(paused.detail).toContain('left_allowed_origin');
    expect(h.decide).not.toHaveBeenCalled();
  });
});

// --- 12.4 persistence + kill switch ---------------------------------------------

describe('persistence and kill switch (12.4)', () => {
  it('persists {runId, config, status, trace, historyCompact, budgets} after every transition', async () => {
    const h = makeHarness();
    scriptDecider(h, [CLICK, FINISH]);
    await h.controller.start(makeConfig(), 1);
    await h.waitForStatus('finished');

    expect(h.persisted.length).toBe(h.states.length);
    const last = h.persisted[h.persisted.length - 1]!;
    expect(last).toMatchObject({
      runId: expect.stringMatching(/^run_/),
      tabId: 1,
      sessionId: 'session_test',
      status: 'finished',
      phase: 'done',
    });
    expect(last.config.goal).toBe('explore the playground');
    expect(last.trace).toHaveLength(2);
    expect(last.historyCompact).toHaveLength(2);
    expect(last.budgets).toMatchObject({ stepsUsed: 2, llmCalls: 2 });
  });

  it('restore() surfaces a persisted running run as paused (service_worker_restarted) with its trace intact', async () => {
    const h = makeHarness();
    scriptDecider(h, [CLICK, FINISH]);
    await h.controller.start(makeConfig(), 1);
    await h.waitForStatus('finished');
    const midRun = h.persisted.find((p) => p.status === 'running' && p.trace.length === 1)!;
    expect(midRun).toBeDefined();

    const fresh = makeHarness();
    await fresh.controller.restore(midRun);
    const state = fresh.lastState();
    expect(state.status).toBe('paused');
    expect(state.detail).toBe('service_worker_restarted');
    expect(state.trace).toHaveLength(1);
    expect(state.runId).toBe(midRun.runId);

    // Resume picks the loop back up from observing and finishes.
    scriptDecider(fresh, [FINISH]);
    fresh.controller.resume();
    const final = await fresh.waitForStatus('finished');
    expect(final.trace).toHaveLength(2);
    expect(fresh.showOverlay).toHaveBeenCalled();
  });

  it('AUTO_USER_STOP finalizes as stopped_by_user and hides the overlay', async () => {
    const h = makeHarness();
    let releaseDecide!: () => void;
    h.decide.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releaseDecide = resolve;
      });
      return { action: CLICK };
    });
    await h.controller.start(makeConfig(), 1);
    await vi.waitFor(() => expect(h.decide).toHaveBeenCalled());

    h.controller.stop();
    releaseDecide();
    const final = await h.waitForStatus('stopped_by_user');
    expect(final.phase).toBe('done');
    expect(h.hideOverlay).toHaveBeenCalled();
    expect(h.stopRecording).toHaveBeenCalled();
  });

  it('AUTO_USER_INTERVENED pauses without killing the run', async () => {
    const h = makeHarness();
    let releaseDecide!: () => void;
    h.decide.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseDecide = resolve;
      });
      return { action: CLICK };
    });
    await h.controller.start(makeConfig(), 1);
    await vi.waitFor(() => expect(h.decide).toHaveBeenCalled());

    h.controller.userIntervened();
    releaseDecide();
    const paused = await h.waitForStatus('paused');
    expect(paused.detail).toBe('user_intervened');
    expect(h.hideOverlay).toHaveBeenCalled(); // pill hidden while paused

    scriptDecider(h, [FINISH]);
    h.controller.resume();
    await h.waitForStatus('finished');
  });

  it('stopping a restored (loop-less) paused run finalizes inline', async () => {
    const h = makeHarness();
    scriptDecider(h, [CLICK, FINISH]);
    await h.controller.start(makeConfig(), 1);
    await h.waitForStatus('finished');
    const midRun = h.persisted.find((p) => p.status === 'running')!;

    const fresh = makeHarness();
    await fresh.controller.restore(midRun);
    fresh.controller.stop();
    const final = await fresh.waitForStatus('stopped_by_user');
    expect(final.trace.length).toBeGreaterThanOrEqual(0);
    expect(fresh.stopRecording).toHaveBeenCalled();
  });
});

describe('clampConfig', () => {
  it('applies §5.4 defaults and the 60-step hard cap', () => {
    const clamped = clampConfig(
      makeConfig({ maxSteps: 200, maxWallClockMs: 0, maxLlmCalls: 0 }),
    );
    expect(clamped.maxSteps).toBe(60);
    expect(clamped.maxWallClockMs).toBe(10 * 60 * 1000);
    expect(clamped.maxLlmCalls).toBe(70);
  });
});

// --- 21.4 loop detection (§9.5) ---------------------------------------------

/** All nudges are HistorySummary lines; collect them from a StepRequest. */
function nudgeLines(request: StepRequest): string[] {
  return request.history
    .filter((item): item is Extract<typeof item, { kind: 'summary' }> => 'kind' in item)
    .map((item) => item.line)
    .filter((line) => line.startsWith('note:'));
}

describe('loop detection (21.4, §9.5)', () => {
  it('injects the nudge at 3 identical actions and finalizes as action loop at 5', async () => {
    const h = makeHarness();
    scriptDecider(h, [CLICK]); // repeats forever
    await h.controller.start(makeConfig(), 1);
    const final = await h.waitForStatus('stopped_by_budget');

    expect(final.detail).toBe('action loop');
    expect(final.trace).toHaveLength(5); // partial trace retained
    // Request for step 4 (after 3 identical recorded steps) carries the nudge…
    expect(nudgeLines(h.requests[3]!)).toEqual([
      'note: you have repeated this action 3 times without progress; try a different approach or finish(blocked)',
    ]);
    // …and it is injected once, not re-sent on the 5th request.
    expect(nudgeLines(h.requests[4]!)).toEqual([]);
    expect(nudgeLines(h.requests[0]!)).toEqual([]);
  });

  it('distinct actions do not accumulate a streak', async () => {
    const h = makeHarness();
    const SCROLL: Action = { type: 'scroll', direction: 'down', amount: 'page' };
    scriptDecider(h, [CLICK, SCROLL, CLICK, SCROLL, CLICK, SCROLL, FINISH]);
    await h.controller.start(makeConfig(), 1);
    const final = await h.waitForStatus('finished');

    expect(final.outcome).toBe('pass');
    for (const request of h.requests) expect(nudgeLines(request)).toEqual([]);
  });

  it('nudges after 3 consecutive failed results even when the actions differ', async () => {
    const h = makeHarness();
    scriptDecider(h, [
      CLICK,
      { type: 'click', index: 1, intent: 'second' },
      { type: 'click', index: 2, intent: 'third' },
      FINISH,
    ]);
    h.execute
      .mockResolvedValueOnce({ ok: false, reason: 'error', detail: 'boom', settled: true, navigated: false })
      .mockResolvedValueOnce({ ok: false, reason: 'error', detail: 'boom', settled: true, navigated: false })
      .mockResolvedValueOnce({ ok: false, reason: 'error', detail: 'boom', settled: true, navigated: false });
    await h.controller.start(makeConfig(), 1);
    await h.waitForStatus('finished');

    expect(nudgeLines(h.requests[3]!)).toEqual([
      'note: your last 3 actions failed; try a different approach or finish(blocked)',
    ]);
  });
});

// --- 22.4 credential vault (§9.4) --------------------------------------------

const SECRET_FIELD = {
  index: 0,
  tag: 'input',
  text: 'Password',
  attributes: {},
  states: [],
  isSecret: true,
};

describe('credential vault (22.4, §9.4)', () => {
  it('substitutes the placeholder for execution while every prompt, state, and trace stays tokenized', async () => {
    const h = makeHarness();
    h.vault['TEST_USER_PASSWORD'] = 's3cret!';
    h.observe.mockImplementation(async () => ({
      ok: true,
      observation: makeObservation({ epoch: h.observe.mock.calls.length }),
      elements: [SECRET_FIELD],
    }));
    const fill: Action = {
      type: 'fill',
      index: 0,
      value: '{{TEST_USER_PASSWORD}}',
      intent: 'enter password',
    };
    scriptDecider(h, [fill, FINISH]);
    await h.controller.start(makeConfig(), 1);
    const final = await h.waitForStatus('finished');

    // The page received the real value…
    expect(h.execute.mock.calls[0]![0]).toEqual({ ...fill, value: 's3cret!' });
    // …and the StepRequest carried names only.
    expect(h.requests[0]!.placeholders).toEqual(['TEST_USER_PASSWORD']);
    // Trace, history, prompts, persisted state, pushed state, RunResult: tokenized.
    expect(final.trace[0]!.action).toEqual(fill);
    for (const blob of [h.requests, h.persisted, h.states, h.runResults]) {
      expect(JSON.stringify(blob)).not.toContain('s3cret!');
    }
  });

  it('refuses a literal value on a secret field and records the refusal for the model', async () => {
    const h = makeHarness();
    h.observe.mockImplementation(async () => ({
      ok: true,
      observation: makeObservation({ epoch: h.observe.mock.calls.length }),
      elements: [SECRET_FIELD],
    }));
    scriptDecider(h, [
      { type: 'fill', index: 0, value: 'hunter2', intent: 'enter password' },
      FINISH,
    ]);
    await h.controller.start(makeConfig(), 1);
    const final = await h.waitForStatus('finished');

    expect(final.trace[0]!.result).toBe('refused');
    expect(final.trace[0]!.resultDetail).toBe('secret fields accept placeholders only');
    expect(h.execute).toHaveBeenCalledTimes(1); // only the finish
    // The refusal is model-visible in the next request's history.
    const historyEntry = h.requests[1]!.history[0]! as HistoryEntry;
    expect(historyEntry.result).toBe('refused');
  });
});

// --- 23.3 confirmation flow (§9.3) -------------------------------------------

const DELETE_BUTTON = {
  index: 0,
  tag: 'button',
  text: 'Delete item',
  attributes: {},
  states: [],
  isSecret: false,
};

function makeConfirmHarness(): Harness {
  const h = makeHarness();
  h.observe.mockImplementation(async () => ({
    ok: true,
    observation: makeObservation({ epoch: h.observe.mock.calls.length }),
    elements: [DELETE_BUTTON],
  }));
  return h;
}

describe('confirmation flow (23.3, §9.3)', () => {
  it('surfaces the pending action and executes it on approval as confirmed_by_user', async () => {
    const h = makeConfirmHarness();
    scriptDecider(h, [CLICK, FINISH]);
    await h.controller.start(makeConfig({ mode: 'confirm' }), 1);

    const awaiting = await h.waitForStatus('awaiting_confirmation');
    expect(awaiting.pendingConfirmation).toMatchObject({
      action: CLICK,
      elementText: 'Delete item',
      reason: 'matches destructive pattern: "delete item"',
    });
    expect(awaiting.pendingConfirmation!.expiresAt).toBe(
      awaiting.pendingConfirmation!.requestedAt + 120_000,
    );
    expect(h.execute).not.toHaveBeenCalled();

    h.controller.confirm(true);
    const final = await h.waitForStatus('finished');
    expect(h.execute).toHaveBeenCalledTimes(2); // click + finish
    expect(final.trace[0]!.result).toBe('confirmed_by_user');
    expect(final.trace[0]!.destructive).toBe(true);
    expect(final.pendingConfirmation).toBeUndefined();
  });

  it('records rejection with the user note and does not execute', async () => {
    const h = makeConfirmHarness();
    scriptDecider(h, [CLICK, FINISH]);
    await h.controller.start(makeConfig({ mode: 'confirm' }), 1);
    await h.waitForStatus('awaiting_confirmation');

    h.controller.confirm(false, 'do not delete test data');
    const final = await h.waitForStatus('finished');
    expect(final.trace[0]!.result).toBe('rejected_by_user');
    expect(final.trace[0]!.resultDetail).toBe('rejected: do not delete test data');
    expect(h.execute).toHaveBeenCalledTimes(1); // only the finish
    // The rejection consumed a step and is model-visible in history.
    const historyEntry = h.requests[1]!.history[0]! as HistoryEntry;
    expect(historyEntry.result).toBe('rejected_by_user');
  });

  it('treats the 120 s timeout as rejection', async () => {
    const h = makeConfirmHarness();
    scriptDecider(h, [CLICK, FINISH]);
    await h.controller.start(makeConfig({ mode: 'confirm' }), 1);
    await h.waitForStatus('awaiting_confirmation');

    h.releaseLongSleeps();
    const final = await h.waitForStatus('finished');
    expect(final.trace[0]!.result).toBe('rejected_by_user');
    expect(final.trace[0]!.resultDetail).toBe('confirmation timed out (120s)');
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('pause during awaiting_confirmation abandons the step without consuming it', async () => {
    const h = makeConfirmHarness();
    scriptDecider(h, [CLICK, FINISH]);
    await h.controller.start(makeConfig({ mode: 'confirm' }), 1);
    await h.waitForStatus('awaiting_confirmation');

    h.controller.pause('paused_by_user');
    const paused = await h.waitForStatus('paused');
    expect(paused.budgets.stepsUsed).toBe(0);
    expect(paused.pendingConfirmation).toBeUndefined();

    scriptDecider(h, [FINISH]); // resume re-observes and re-decides
    h.controller.resume();
    const final = await h.waitForStatus('finished');
    expect(final.trace).toHaveLength(1);
    expect(final.trace[0]!.action.type).toBe('finish');
  });

  it('a verdict with no pending confirmation is logged and ignored', async () => {
    const h = makeHarness();
    scriptDecider(h, [FINISH]);
    await h.controller.start(makeConfig({ mode: 'confirm' }), 1);
    await h.waitForStatus('finished');
    h.controller.confirm(true);
    expect(h.logs.some((l) => l.includes('no pending confirmation'))).toBe(true);
  });
});

// --- 24.2 defect & assertion plumbing into RunResult (§5.4) -------------------

describe('RunResult plumbing (24.2, §5.4)', () => {
  const DEFECT: Action = {
    type: 'report_defect',
    severity: 'high',
    summary: 'save returns 500',
    expected: 'item saved',
    actual: 'HTTP 500',
  };
  const ASSERT: Action = {
    type: 'assert',
    expectation: 'list shows the item',
    holds: false,
    evidence: 'list is empty',
  };

  it('collects defects and assertions into the persisted RunResult on finish', async () => {
    const h = makeHarness();
    scriptDecider(h, [DEFECT, ASSERT, FINISH]);
    await h.controller.start(makeConfig(), 1);
    await h.waitForStatus('finished');

    expect(h.runResults).toHaveLength(1);
    const result = h.runResults[0]!;
    expect(result.status).toBe('finished');
    expect(result.outcome).toBe('pass');
    expect(result.sessionId).toBe('session_test');
    expect(result.trace).toHaveLength(3);
    expect(result.defects).toEqual([{ ...DEFECT, step: 1 }]);
    expect(result.assertions).toEqual([{ ...ASSERT, step: 2 }]);
  });

  it('budget stops still persist the partial defect/assertion data', async () => {
    const h = makeHarness();
    const SCROLL: Action = { type: 'scroll', direction: 'down', amount: 'page' };
    const SCROLL_UP: Action = { type: 'scroll', direction: 'up', amount: 'page' };
    scriptDecider(h, [DEFECT, SCROLL, SCROLL_UP]);
    await h.controller.start(makeConfig({ maxSteps: 3 }), 1);
    await h.waitForStatus('stopped_by_budget');

    expect(h.runResults).toHaveLength(1);
    const result = h.runResults[0]!;
    expect(result.status).toBe('stopped_by_budget');
    expect(result.defects).toEqual([{ ...DEFECT, step: 1 }]);
    expect(result.assertions).toEqual([]);
    expect(result.trace).toHaveLength(3);
  });
});

describe('per-run metrics (28.1, §12)', () => {
  it('accumulates steps, llm calls, refusals, and wall clock into RunResult.metrics', async () => {
    const h = makeHarness();
    const FILL: Action = { type: 'fill', index: 0, value: 'x', intent: 'try to type' };
    scriptDecider(h, [FILL, FINISH]);
    // observe_only refuses the fill (§9.2) — the refusal must be counted.
    await h.controller.start(makeConfig({ mode: 'observe_only' }), 1);
    await h.waitForStatus('finished');

    expect(h.runResults[0]!.metrics).toEqual({
      steps: 2,
      llmCalls: 2,
      correctionTurns: 0,
      refusals: 1,
      confirmations: 0,
      wallClockMs: h.clock.t,
    });
  });

  it('counts correction turns in the metrics', async () => {
    const h = makeHarness();
    let call = 0;
    h.decide.mockImplementation(async () =>
      call++ === 0
        ? ({ action: { type: 'execute_js' } } as unknown as StepResponse)
        : { action: FINISH },
    );
    await h.controller.start(makeConfig(), 1);
    await h.waitForStatus('finished');

    expect(h.runResults[0]!.metrics).toMatchObject({
      steps: 1,
      llmCalls: 2,
      correctionTurns: 1,
    });
  });

  it('stopped_by_budget results still carry the partial metrics', async () => {
    const h = makeHarness();
    const SCROLL: Action = { type: 'scroll', direction: 'down', amount: 'page' };
    const SCROLL_UP: Action = { type: 'scroll', direction: 'up', amount: 'page' };
    scriptDecider(h, [SCROLL, SCROLL_UP, SCROLL]);
    await h.controller.start(makeConfig({ maxSteps: 3 }), 1);
    await h.waitForStatus('stopped_by_budget');

    expect(h.runResults[0]!.metrics).toMatchObject({ steps: 3, llmCalls: 3, refusals: 0 });
  });
});

// --- run lifecycle hardening (eval-harness incident follow-up) ----------------

describe('run lifecycle hardening', () => {
  it('stop() during a hung decide finalizes stopped_by_user once the call rejects, without a retry', async () => {
    const h = makeHarness();
    let rejectDecide!: (err: Error) => void;
    h.decide.mockImplementationOnce(
      () =>
        new Promise<StepResponse>((_resolve, reject) => {
          rejectDecide = reject;
        }),
    );
    await h.controller.start(makeConfig(), 1);
    await vi.waitFor(() => expect(h.decide).toHaveBeenCalled());

    h.controller.stop();
    rejectDecide(new Error('decider request timed out after 120000ms'));
    const final = await h.waitForStatus('stopped_by_user');
    expect(final.phase).toBe('done');
    // The pending stop preempts the transport retry: one decide call only.
    expect(h.decide).toHaveBeenCalledTimes(1);
    expect(h.runResults[0]!.status).toBe('stopped_by_user');
  });

  it('tabClosed ends an active run as error (tab closed)', async () => {
    const h = makeHarness();
    let releaseDecide!: () => void;
    h.decide.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseDecide = resolve;
      });
      return { action: CLICK };
    });
    await h.controller.start(makeConfig(), 1);
    await vi.waitFor(() => expect(h.decide).toHaveBeenCalled());

    h.controller.tabClosed(1);
    releaseDecide();
    const final = await h.waitForStatus('error');
    expect(final.detail).toBe('tab closed');
    expect(h.stopRecording).toHaveBeenCalled();
  });

  it('tabClosed for another tab is a no-op', async () => {
    const h = makeHarness();
    scriptDecider(h, [FINISH]);
    await h.controller.start(makeConfig(), 1);
    h.controller.tabClosed(99);
    const final = await h.waitForStatus('finished');
    expect(final.status).toBe('finished');
  });

  it('tabClosed finalizes a paused restored (loop-less) run inline', async () => {
    const h = makeHarness();
    scriptDecider(h, [CLICK, FINISH]);
    await h.controller.start(makeConfig(), 1);
    await h.waitForStatus('finished');
    const midRun = h.persisted.find((p) => p.status === 'running')!;

    // Restored-as-paused run whose tab closes: previously nothing ever
    // finalized it and it blocked new runs for the browser-session lifetime.
    const fresh = makeHarness();
    await fresh.controller.restore(midRun);
    fresh.controller.tabClosed(midRun.tabId);
    const final = await fresh.waitForStatus('error');
    expect(final.detail).toBe('tab closed');
    expect(fresh.stopRecording).toHaveBeenCalled();
  });

  it('tabClosed during awaiting_confirmation unblocks the wait and finalizes', async () => {
    const h = makeConfirmHarness();
    scriptDecider(h, [CLICK, FINISH]);
    await h.controller.start(makeConfig({ mode: 'confirm' }), 1);
    await h.waitForStatus('awaiting_confirmation');

    h.controller.tabClosed(1);
    const final = await h.waitForStatus('error');
    expect(final.detail).toBe('tab closed');
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('never persists a non-final status once finalizing begins (SW-suspension safety)', async () => {
    const h = makeHarness();
    scriptDecider(h, [FINISH]);
    await h.controller.start(makeConfig(), 1);
    await h.waitForStatus('finished');

    // A SW suspension between the finalizing persist and the final-status
    // write must not resurrect the run as paused on the next wake.
    const finalizing = h.persisted.filter((p) => p.phase === 'finalizing');
    expect(finalizing.length).toBeGreaterThan(0);
    for (const record of finalizing) expect(record.status).toBe('finished');
  });
});
