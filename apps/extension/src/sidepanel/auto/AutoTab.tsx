/**
 * Auto tab (auto-test-mode-spec §10): setup view (goal, suggested-case
 * picker, mode + autonomous ack, max-steps slider, origin allowlist,
 * credentials editor), run view (status pill, budget bars, live timeline,
 * confirmation modal, pause/resume/stop), and result view (outcome banner,
 * defects, assertion summary, metrics, exports into existing generators).
 *
 * Rendering-free logic lives in setup-logic / run-view-logic / result-logic /
 * vault so it stays unit-testable without React.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RunMode, RunResult } from '@qa-copilot/shared/auto';
import { RUN_DEFAULTS } from '@qa-copilot/shared/auto';
import type { AutoStateMsg } from '../../background/auto/messages.js';
import type { PanelState } from '../../shared/messages.js';
import { downloadJson } from '../exports.js';
import {
  buildRunConfig,
  formatSuggestedGoal,
  parseOrigins,
  startBlocker,
  type SuggestedCase,
} from './setup-logic.js';
import { budgetBars, summarizeAction, toTimelineRow } from './run-view-logic.js';
import {
  assertionSummary,
  buildDefectPrefill,
  metricsRows,
  type DefectPrefill,
} from './result-logic.js';
import { addCredential, clearCredentials, listCredentialNames, removeCredential } from './vault.js';

interface StartResponse {
  ok: boolean;
  runId?: string;
  error?: string;
}

function sendAuto<T = { ok: boolean }>(message: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

const ACTIVE_STATUSES = ['running', 'paused', 'awaiting_confirmation'] as const;

export interface AutoTabProps {
  state: PanelState;
  /** Picker source (§10): from the last analyze/test-cases results. */
  suggestedCases: SuggestedCase[];
  /** Defect card → open the existing bug-report generator prefilled (§11). */
  onGenerateBugReport: (defect: DefectPrefill) => void;
  /** Result-view buttons that land in the existing Generate tab (§10). */
  onOpenGenerate: () => void;
}

export function AutoTab({ state, suggestedCases, onGenerateBugReport, onOpenGenerate }: AutoTabProps) {
  const [run, setRun] = useState<AutoStateMsg | null>(null);
  const [dismissedSession, setDismissedSession] = useState<string | null>(null);

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

  const active =
    run !== null && (ACTIVE_STATUSES as readonly string[]).includes(run.status);
  const result = state.session.autoRunResult;
  const showResult = !active && result !== undefined && state.session.id !== dismissedSession;

  return (
    <div className="auto-tab section">
      <h3>Auto Test</h3>
      {active && run ? (
        <RunView run={run} />
      ) : showResult && result ? (
        <ResultView
          result={result}
          session={state.session}
          onGenerateBugReport={onGenerateBugReport}
          onOpenGenerate={onOpenGenerate}
          onNewRun={() => setDismissedSession(state.session.id)}
        />
      ) : (
        <SetupView activeOrigin={state.activeOrigin} suggestedCases={suggestedCases} />
      )}
    </div>
  );
}

// --- Setup view (§10) --------------------------------------------------------

function SetupView({
  activeOrigin,
  suggestedCases,
}: {
  activeOrigin: string | null;
  suggestedCases: SuggestedCase[];
}) {
  const [goal, setGoal] = useState('');
  const [mode, setMode] = useState<RunMode>('confirm');
  const [ackAutonomous, setAckAutonomous] = useState(false);
  const [maxSteps, setMaxSteps] = useState<number>(RUN_DEFAULTS.maxSteps);
  const [originsText, setOriginsText] = useState('');
  const [deciderUrl, setDeciderUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Prefill the allowlist with the active tab's origin (§10).
  useEffect(() => {
    if (activeOrigin) setOriginsText((text) => (text.trim() ? text : activeOrigin));
  }, [activeOrigin]);

  const origins = useMemo(() => parseOrigins(originsText), [originsText]);
  const blocker = startBlocker({ goal, mode, ackAutonomous, maxSteps, origins });

  const start = useCallback(async () => {
    setError(null);
    const config = buildRunConfig({ goal, mode, ackAutonomous, maxSteps, origins }, deciderUrl);
    const res = await sendAuto<StartResponse>({ type: 'AUTO_START', config });
    if (!res.ok) setError(res.error ?? 'Failed to start run.');
  }, [goal, mode, ackAutonomous, maxSteps, origins, deciderUrl]);

  return (
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

      {suggestedCases.length > 0 && (
        <label>
          Use a suggested test case
          <select
            value=""
            onChange={(e) => {
              const picked = suggestedCases[Number(e.target.value)];
              if (picked) setGoal(formatSuggestedGoal(picked));
            }}
          >
            <option value="">— pick to prefill the goal —</option>
            {suggestedCases.map((c, i) => (
              <option key={i} value={i}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
      )}

      <fieldset className="auto-mode">
        <legend>Mode</legend>
        {(
          [
            ['observe_only', 'Observe only'],
            ['confirm', 'Confirm actions'],
            ['autonomous', 'Autonomous'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="auto-radio">
            <input
              type="radio"
              name="auto-mode"
              value={value}
              checked={mode === value}
              onChange={() => setMode(value)}
            />
            {label}
          </label>
        ))}
        {mode === 'autonomous' && (
          <label className="auto-radio warn">
            <input
              type="checkbox"
              checked={ackAutonomous}
              onChange={(e) => setAckAutonomous(e.target.checked)}
            />
            I understand: actions (including destructive ones) run without confirmation.
          </label>
        )}
      </fieldset>

      <label>
        Max steps: <b>{maxSteps}</b>
        <input
          type="range"
          min={5}
          max={RUN_DEFAULTS.maxStepsHardCap}
          value={maxSteps}
          onChange={(e) => setMaxSteps(Number(e.target.value))}
        />
      </label>

      <label>
        Allowed origins (one per line)
        <textarea
          rows={2}
          value={originsText}
          onChange={(e) => setOriginsText(e.target.value)}
          placeholder="https://staging.example.com"
        />
      </label>
      {originsText.trim() && origins.length === 0 && (
        <div className="warn">No valid origins — enter full URLs (https://…).</div>
      )}

      <CredentialsEditor />

      <label>
        Decider URL (dev override)
        <input
          type="text"
          value={deciderUrl}
          onChange={(e) => setDeciderUrl(e.target.value)}
          placeholder="defaults to backend URL"
        />
      </label>

      <button className="primary" disabled={blocker !== null} onClick={() => void start()}>
        Start run
      </button>
      {blocker && <div className="muted">{blocker}</div>}
      {error && <div className="warn">{error}</div>}
    </div>
  );
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
    void listCredentialNames().then(setNames);
  }, []);

  const add = useCallback(async () => {
    setNames(await addCredential(name, value));
    setName('');
    setValue('');
  }, [name, value]);

  return (
    <div className="auto-credentials">
      <b>Credentials (session only)</b>
      <ul>
        {names.map((n) => (
          <li key={n}>
            <code>{`{{${n}}}`}</code> ••••••{' '}
            <button className="ghost" onClick={() => void removeCredential(n).then(setNames)}>
              Remove
            </button>
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
        <button className="ghost" onClick={() => void add()} disabled={!name.trim() || !value}>
          Add
        </button>
        {names.length > 0 && (
          <button className="ghost" onClick={() => void clearCredentials().then(setNames)}>
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}

// --- Run view (§10) ----------------------------------------------------------

function RunView({ run }: { run: AutoStateMsg }) {
  return (
    <div className="auto-run">
      <div className="row">
        <span className={`chip ${run.status === 'paused' ? '' : 'rec'}`}>{run.status}</span>
        {run.detail && <span className="muted">{run.detail}</span>}
      </div>

      {budgetBars(run.budgets).map((bar) => (
        <div key={bar.label} className="budget">
          <span className="budget-label">
            {bar.label} {bar.used}/{bar.max}
          </span>
          <div className="budget-track">
            <div className="budget-fill" style={{ width: `${bar.pct}%` }} />
          </div>
        </div>
      ))}

      <div className="auto-controls row">
        {run.status === 'paused' ? (
          <button
            className="primary"
            onClick={() => void sendAuto({ type: 'AUTO_RESUME', runId: run.runId })}
          >
            Resume
          </button>
        ) : (
          <button
            className="ghost"
            onClick={() => void sendAuto({ type: 'AUTO_PAUSE', runId: run.runId })}
          >
            Pause
          </button>
        )}
        <button className="ghost" onClick={() => void sendAuto({ type: 'AUTO_STOP', runId: run.runId })}>
          Stop
        </button>
      </div>

      <Timeline run={run} />

      {run.status === 'awaiting_confirmation' && run.pendingConfirmation && (
        <ConfirmationModal run={run} />
      )}
    </div>
  );
}

/** Live TraceStep timeline: `#n [icon] intent — action summary → result` (§10). */
function Timeline({ run }: { run: AutoStateMsg }) {
  return (
    <ol className="auto-trace">
      {run.trace.map(toTimelineRow).map((row) => (
        <li key={row.step}>
          <span className="muted">#{row.step}</span> {row.icon}{' '}
          {row.intent && <>{row.intent} — </>}
          <code>{row.summary}</code>
          {row.destructive ? ' ⚠' : ''} → {row.result}
          {row.assertChip && (
            <span className={`chip ${row.assertChip === 'pass' ? 'ok' : 'rec'}`}>
              {row.assertChip === 'pass' ? '✅ pass' : '❌ fail'}
            </span>
          )}
          {row.defect && (
            <div className="defect-card">
              <b>🐞 {row.defect.severity}:</b> {row.defect.summary}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Confirmation modal (§9.3, §10): Approve / Reject-with-note + 120 s countdown. */
function ConfirmationModal({ run }: { run: AutoStateMsg }) {
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
    <div className="modal-backdrop">
      <div className="modal" role="alertdialog" aria-label="Confirm action">
        <b>Confirm action</b>
        <div className="muted">{secondsLeft}s — no answer rejects</div>
        <div style={{ margin: '6px 0' }}>
          <code>{summarizeAction(pending.action)}</code>
          {pending.elementText ? (
            <>
              {' '}
              on “<b>{pending.elementText}</b>”
            </>
          ) : null}
        </div>
        <div className="warn">{pending.reason}</div>
        <textarea
          rows={2}
          placeholder="Optional note (recorded on reject)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="row" style={{ marginTop: 6 }}>
          <button className="primary" onClick={() => respond(true)}>
            Approve
          </button>
          <button className="ghost" onClick={() => respond(false)}>
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Result view (§10, §12) --------------------------------------------------

function ResultView({
  result,
  session,
  onGenerateBugReport,
  onOpenGenerate,
  onNewRun,
}: {
  result: RunResult;
  session: PanelState['session'];
  onGenerateBugReport: (defect: DefectPrefill) => void;
  onOpenGenerate: () => void;
  onNewRun: () => void;
}) {
  const asserts = assertionSummary(result);
  const banner =
    result.outcome ?? (result.status === 'finished' ? 'pass' : result.status.replace(/_/g, ' '));
  const bannerClass =
    result.outcome === 'pass' ? 'ok' : result.outcome === 'fail' ? 'rec' : '';

  return (
    <div className="auto-result">
      <div className="row">
        <span className={`chip ${bannerClass}`}>
          {banner}
          {result.reason ? ` — ${result.reason}` : ''}
        </span>
      </div>

      {result.defects.length > 0 && (
        <>
          <h3>Defects</h3>
          {result.defects.map((defect, i) => (
            <div key={i} className="defect-card">
              <div>
                <b>🐞 {defect.severity}:</b> {defect.summary}
              </div>
              <div className="muted">
                Expected: {defect.expected} · Actual: {defect.actual}
              </div>
              <button
                className="ghost"
                onClick={() => onGenerateBugReport(buildDefectPrefill(result, defect))}
              >
                Generate bug report
              </button>
            </div>
          ))}
        </>
      )}

      <h3>Assertions</h3>
      <div className="row">
        <span className="chip ok">{asserts.passed} passed</span>
        <span className={`chip ${asserts.failed > 0 ? 'rec' : ''}`}>{asserts.failed} failed</span>
      </div>

      <h3>Metrics</h3>
      <div className="row">
        {metricsRows(result).map((row) => (
          <span key={row.label} className="chip">
            {row.label}: {row.value}
          </span>
        ))}
      </div>

      <h3>Timeline</h3>
      <ol className="auto-trace">
        {result.trace.map(toTimelineRow).map((row) => (
          <li key={row.step}>
            <span className="muted">#{row.step}</span> {row.icon}{' '}
            {row.intent && <>{row.intent} — </>}
            <code>{row.summary}</code> → {row.result}
          </li>
        ))}
      </ol>

      <div className="row" style={{ marginTop: 8 }}>
        <button className="ghost" onClick={() => downloadJson(`${session.id}.json`, session)}>
          Export session JSON
        </button>
        <button className="ghost" onClick={onOpenGenerate}>
          Generate Playwright draft
        </button>
        <button className="ghost" onClick={onOpenGenerate}>
          Generate bug report
        </button>
        <button className="primary" onClick={onNewRun}>
          New run
        </button>
      </div>
    </div>
  );
}
