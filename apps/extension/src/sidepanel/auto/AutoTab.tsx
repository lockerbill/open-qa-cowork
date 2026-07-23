/**
 * Minimal Auto tab (M2/M4, auto-test-mode-spec §10): enough surface to start,
 * pause, resume, and stop a run, seed the credential vault, answer
 * confirmation requests, and watch status/trace live — the dev and E2E entry
 * point for the orchestrator. The full setup/run/result UI (suggested-case
 * picker, budget bars, exports, modal polish) lands in M5.
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

/** chrome.storage.session key shared with the SW's readVault (wiring.ts). */
const VAULT_KEY = 'autoVault';

function sendAuto<T = { ok: boolean }>(message: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

/**
 * Credentials editor (§9.4, §10): name → value rows written directly to
 * chrome.storage.session (the panel is a trusted context) — values never
 * travel through runtime messages and clear when the browser closes. Values
 * are masked after entry; only names are ever shown again.
 */
function CredentialsEditor() {
  const [names, setNames] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');

  useEffect(() => {
    void chrome.storage.session.get(VAULT_KEY).then((stored) => {
      const vault = stored[VAULT_KEY] as Record<string, string> | undefined;
      setNames(Object.keys(vault ?? {}));
    });
  }, []);

  const add = useCallback(async () => {
    const trimmed = name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!trimmed || !value) return;
    const stored = await chrome.storage.session.get(VAULT_KEY);
    const vault = { ...((stored[VAULT_KEY] as Record<string, string> | undefined) ?? {}) };
    vault[trimmed] = value;
    await chrome.storage.session.set({ [VAULT_KEY]: vault });
    setNames(Object.keys(vault));
    setName('');
    setValue('');
  }, [name, value]);

  const remove = useCallback(async (target: string) => {
    const stored = await chrome.storage.session.get(VAULT_KEY);
    const vault = { ...((stored[VAULT_KEY] as Record<string, string> | undefined) ?? {}) };
    delete vault[target];
    await chrome.storage.session.set({ [VAULT_KEY]: vault });
    setNames(Object.keys(vault));
  }, []);

  return (
    <div className="auto-credentials">
      <b>Credentials (session only)</b>
      <ul>
        {names.map((n) => (
          <li key={n}>
            <code>{`{{${n}}}`}</code> ••••••{' '}
            <button onClick={() => void remove(n)}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="auto-credentials-row">
        <input
          type="text"
          placeholder="NAME (e.g. TEST_USER_PASSWORD)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="password"
          placeholder="value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button onClick={() => void add()} disabled={!name.trim() || !value}>
          Add
        </button>
      </div>
    </div>
  );
}

/** Human-readable one-liner of the action awaiting confirmation. */
function summarizeAction(action: Record<string, unknown>): string {
  const parts: string[] = [String(action.type)];
  if (typeof action.index === 'number') parts.push(`[${action.index}]`);
  if (typeof action.value === 'string') parts.push(JSON.stringify(action.value));
  if (typeof action.url === 'string') parts.push(String(action.url));
  if (typeof action.intent === 'string') parts.push(`— ${action.intent}`);
  return parts.join(' ');
}

/** Confirmation prompt (§9.3, §10): Approve / Reject-with-note + countdown. */
function ConfirmationPrompt({ run }: { run: AutoStateMsg }) {
  const pending = run.pendingConfirmation!;
  const [note, setNote] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(
    Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000)),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [pending.expiresAt]);

  const respond = (approved: boolean) =>
    void sendAuto({
      type: 'AUTO_CONFIRMATION',
      runId: run.runId,
      approved,
      ...(approved || !note.trim() ? {} : { note: note.trim() }),
    });

  return (
    <div className="auto-confirmation" role="alertdialog" aria-label="Confirm action">
      <b>Confirm action</b> ({secondsLeft}s — no answer rejects)
      <div>
        <code>{summarizeAction(pending.action)}</code>
        {pending.elementText ? ` on “${pending.elementText}”` : ''}
      </div>
      <div className="warn">{pending.reason}</div>
      <textarea
        rows={2}
        placeholder="Optional note (recorded on reject)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="auto-controls">
        <button onClick={() => respond(true)}>Approve</button>
        <button onClick={() => respond(false)}>Reject</button>
      </div>
    </div>
  );
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
          <CredentialsEditor />
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
          {run.status === 'awaiting_confirmation' && run.pendingConfirmation && (
            <ConfirmationPrompt run={run} />
          )}
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
                {step.destructive ? ' ⚠' : ''}
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
