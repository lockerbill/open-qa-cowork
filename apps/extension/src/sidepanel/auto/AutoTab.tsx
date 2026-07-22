/**
 * Minimal Auto tab (M2, auto-test-mode-spec §10): enough surface to start,
 * pause, resume, and stop a run and watch its status/trace live — the dev and
 * E2E entry point for the orchestrator. The full setup/run/result UI
 * (suggested-case picker, credentials editor, confirmation modal, budget
 * bars, exports) lands in M4/M5.
 */
import { useCallback, useEffect, useState } from 'react';
import type { RunConfig, RunMode } from '@qa-copilot/shared/auto';
import { RUN_DEFAULTS } from '@qa-copilot/shared/auto';
import type { AutoStateMsg } from '../../background/auto/messages.js';

interface StartResponse {
  ok: boolean;
  runId?: string;
  error?: string;
}

function sendAuto<T = { ok: boolean }>(message: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

export function AutoTab({ activeOrigin }: { activeOrigin: string | null }) {
  const [goal, setGoal] = useState('');
  const [mode, setMode] = useState<RunMode>('confirm');
  const [maxSteps, setMaxSteps] = useState<number>(RUN_DEFAULTS.maxSteps);
  const [deciderUrl, setDeciderUrl] = useState('');
  const [run, setRun] = useState<AutoStateMsg | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void sendAuto<{ ok: boolean; state: AutoStateMsg | null }>({ type: 'AUTO_GET_STATE' }).then(
      (res) => {
        if (res?.state) setRun(res.state);
      },
    );
    const listener = (msg: { type?: string }) => {
      if (msg?.type === 'AUTO_STATE') setRun(msg as AutoStateMsg);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const running = run !== null && (run.status === 'running' || run.status === 'paused' || run.status === 'awaiting_confirmation');

  const start = useCallback(async () => {
    setError(null);
    if (!goal.trim()) {
      setError('Enter a goal first.');
      return;
    }
    if (!activeOrigin) {
      setError('No active tab origin to run against.');
      return;
    }
    const config: RunConfig = {
      goal: goal.trim(),
      mode,
      maxSteps,
      maxWallClockMs: RUN_DEFAULTS.maxWallClockMs,
      maxLlmCalls: maxSteps + 10,
      originAllowlist: [activeOrigin],
      ...(deciderUrl.trim() && { deciderBaseUrl: deciderUrl.trim() }),
    };
    const res = await sendAuto<StartResponse>({ type: 'AUTO_START', config });
    if (!res.ok) setError(res.error ?? 'Failed to start run.');
  }, [goal, mode, maxSteps, deciderUrl, activeOrigin]);

  return (
    <div className="auto-tab">
      <h3>Auto Test (experimental)</h3>

      {!running && (
        <div className="auto-setup">
          <label>
            Goal
            <textarea
              rows={3}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="e.g. Log in and create an item"
            />
          </label>
          <label>
            Mode
            <select value={mode} onChange={(e) => setMode(e.target.value as RunMode)}>
              <option value="observe_only">Observe only</option>
              <option value="confirm">Confirm actions</option>
              <option value="autonomous">Autonomous</option>
            </select>
          </label>
          <label>
            Max steps
            <input
              type="number"
              min={5}
              max={RUN_DEFAULTS.maxStepsHardCap}
              value={maxSteps}
              onChange={(e) => setMaxSteps(Number(e.target.value) || RUN_DEFAULTS.maxSteps)}
            />
          </label>
          <label>
            Decider URL (dev override)
            <input
              type="text"
              value={deciderUrl}
              onChange={(e) => setDeciderUrl(e.target.value)}
              placeholder="defaults to backend URL"
            />
          </label>
          <button onClick={() => void start()}>Start run</button>
        </div>
      )}

      {error && <div className="warn">{error}</div>}

      {run && (
        <div className="auto-run">
          <div>
            <b>Status:</b> {run.status}
            {run.detail ? ` — ${run.detail}` : ''}
            {run.outcome ? ` (${run.outcome}${run.reason ? `: ${run.reason}` : ''})` : ''}
          </div>
          <div>
            Steps {run.budgets.stepsUsed}/{run.budgets.maxSteps} · LLM calls{' '}
            {run.budgets.llmCalls}/{run.budgets.maxLlmCalls}
          </div>
          {running && (
            <div className="auto-controls">
              {run.status === 'paused' ? (
                <button onClick={() => void sendAuto({ type: 'AUTO_RESUME', runId: run.runId })}>
                  Resume
                </button>
              ) : (
                <button onClick={() => void sendAuto({ type: 'AUTO_PAUSE', runId: run.runId })}>
                  Pause
                </button>
              )}
              <button onClick={() => void sendAuto({ type: 'AUTO_STOP', runId: run.runId })}>
                Stop
              </button>
            </div>
          )}
          <ol className="auto-trace">
            {run.trace.map((step) => (
              <li key={step.step}>
                <code>{step.action.type}</code>
                {step.intent ? ` — ${step.intent}` : ''} → {step.result}
                {step.resultDetail ? ` (${step.resultDetail})` : ''}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
