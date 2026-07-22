/**
 * Run-controller unit suite (tasks 9.4 / 10.7 / 11.3 / 12.4): the whole
 * machine runs against fake deps — no chrome, no DOM. Scenario scripting:
 * queue decider responses and executor results, then await the final pushed
 * AUTO_STATE.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  Action,
  Observation,
  RunConfig,
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
import { clampConfig, RunController, type RunControllerDeps } from './run-controller.js';

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
  lastState(): AutoStateMsg;
  phases(): RunPhase[];
  waitForStatus(status: string): Promise<AutoStateMsg>;
}

function makeHarness(): Harness {
  const states: AutoStateMsg[] = [];
  const persisted: PersistedAutoRun[] = [];
  const logs: string[] = [];
  const requests: StepRequest[] = [];
  const clock = { t: 0 };

  const observe = vi.fn(
    async (): Promise<AutoObserveResponse> => ({
      ok: true,
      observation: makeObservation({ epoch: observe.mock.calls.length }),
      elements: [],
    }),
  );
  const execute = vi.fn(async (): Promise<AutoExecuteResponse> => OK);
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
    execute: (_tabId, _runId, _epoch, _action) => execute(),
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
    expect(lastRequest.history[0]!.result).toBe('refused');
    expect(lastRequest.history[0]!.resultDetail).toBe('navigation outside allowed origin');
    // The refused navigate never reached the executor — only the finish did.
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('an invalid decider action records the step as failed (model_output_invalid)', async () => {
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
    expect(final.trace[0]!.result).toBe('failed');
    expect(final.trace[0]!.resultDetail).toBe('model_output_invalid');
    // The invalid action never reached the executor — only the finish did.
    expect(h.execute).toHaveBeenCalledTimes(1);
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
    expect(finishRequest.history[0]!.newErrors).toBe(1);
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
