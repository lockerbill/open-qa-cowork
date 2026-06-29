import { useCallback, useEffect, useState } from 'react';
import { buildSessionMarkdown } from '@qa-copilot/shared';
import type { PanelState, Settings } from '../shared/messages.js';
import { STATE_CHANGED } from '../shared/messages.js';
import * as bg from './chrome-client.js';
import {
  analyzePage,
  generateBugReport,
  generatePlaywright,
  generateTestCases,
  type AnalyzeResponse,
  type GenerateResponse,
} from './backend.js';
import { downloadJson, downloadMarkdown, downloadTypeScript } from './exports.js';
import { previewMarkdown } from './preview.js';

type Tab = 'page' | 'session' | 'generate';

export function App() {
  const [state, setState] = useState<PanelState | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tab, setTab] = useState<Tab>('page');

  const refresh = useCallback(async () => {
    setState(await bg.getState());
  }, []);

  useEffect(() => {
    void refresh();
    void bg.getSettings().then(setSettings);
    const listener = (msg: { type?: string }) => {
      if (msg?.type === STATE_CHANGED) void refresh();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [refresh]);

  if (!state) return <div className="app" style={{ padding: 16 }}>Loading…</div>;

  const summary = state.pageModel?.summary;

  return (
    <div className="app">
      <header className="bar">
        <div className="title">
          QA Copilot
          {state.recording ? (
            <span className="chip rec">● recording</span>
          ) : (
            <span className="chip">idle</span>
          )}
        </div>
        <div className="url">{summary?.title ?? 'No page scanned'}</div>
        <div className="url">{summary?.url ?? state.activeOrigin ?? ''}</div>
      </header>

      {!state.allowed && state.activeOrigin && (
        <AllowlistBanner origin={state.activeOrigin} onEnabled={refresh} />
      )}

      <nav className="tabs">
        <button className={tab === 'page' ? 'active' : ''} onClick={() => setTab('page')}>
          Page
        </button>
        <button className={tab === 'session' ? 'active' : ''} onClick={() => setTab('session')}>
          Session ({state.session.events.length})
        </button>
        <button className={tab === 'generate' ? 'active' : ''} onClick={() => setTab('generate')}>
          Generate
        </button>
      </nav>

      <div className="content">
        {tab === 'page' && <PageTab state={state} settings={settings} />}
        {tab === 'session' && <SessionTab state={state} onChange={refresh} />}
        {tab === 'generate' && <GenerateTab state={state} settings={settings} />}
      </div>
    </div>
  );
}

function AllowlistBanner({ origin, onEnabled }: { origin: string; onEnabled: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="warn">
      QA Copilot is not enabled on <b>{origin}</b>.{' '}
      <button
        className="ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const res = await bg.addAllowlistOrigin(origin);
          setBusy(false);
          if (res.ok) onEnabled();
        }}
      >
        Enable here
      </button>
    </div>
  );
}

function PageTab({ state, settings }: { state: PanelState; settings: Settings | null }) {
  const summary = state.pageModel?.summary;
  const [answer, setAnswer] = useState<AnalyzeResponse | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    if (!state.pageModel || !settings) return;
    setBusy(true);
    setErr('');
    try {
      setAnswer(
        await analyzePage(settings.backendUrl, {
          pageModel: state.pageModel,
          question: 'What should I test on this page?',
          environment: settings.environment,
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="section">
      <div className="row">
        <button className="primary" onClick={() => bg.scanActiveTab()}>
          Scan page
        </button>
        <button className="ghost" disabled={!state.pageModel || busy} onClick={ask}>
          {busy ? 'Asking…' : 'What should I test?'}
        </button>
      </div>

      {err && <p className="err">{err}</p>}

      {answer && (
        <>
          <h3>AI suggestions</h3>
          <p>{answer.summary}</p>
          {answer.risks.length > 0 && (
            <>
              <h3>Risks</h3>
              <ul className="tight">
                {answer.risks.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </>
          )}
          {answer.suggestedTests.length > 0 && (
            <>
              <h3>Suggested tests</h3>
              <ul className="tight">
                {answer.suggestedTests.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {summary ? (
        <>
          <h3>Page summary</h3>
          <div className="row">
            <span className="chip">{summary.forms.length} forms</span>
            <span className="chip">{summary.buttons.length} buttons</span>
            <span className="chip">{summary.links.length} links</span>
            <span className="chip">{summary.tables.length} tables</span>
            <span className="chip">{state.pageModel?.elements.length ?? 0} elements</span>
          </div>
          {summary.headings.length > 0 && (
            <>
              <h3>Headings</h3>
              <ul className="tight">
                {summary.headings.slice(0, 8).map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            </>
          )}
          {summary.validationMessages.length > 0 && (
            <>
              <h3>Validation messages</h3>
              <ul className="tight">
                {summary.validationMessages.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </>
          )}
          <details>
            <summary className="muted">Raw page model (JSON)</summary>
            <pre className="artifact">{JSON.stringify(state.pageModel, null, 2)}</pre>
          </details>
        </>
      ) : (
        <p className="muted">Click “Scan page” to analyze the current tab.</p>
      )}
    </div>
  );
}

function SessionTab({ state, onChange }: { state: PanelState; onChange: () => void }) {
  const { session, recording } = state;
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  const screenshots = session.evidence.filter((e) => e.type === 'screenshot' && e.dataUrl);
  return (
    <div className="section">
      <div className="row">
        {recording ? (
          <button className="primary" onClick={async () => (await bg.stopRecording(), onChange())}>
            Stop recording
          </button>
        ) : (
          <button className="primary" onClick={async () => (await bg.startRecording(), onChange())}>
            Start recording
          </button>
        )}
        <button
          className="ghost"
          onClick={async () => {
            const r = await bg.captureScreenshot();
            if (!r.ok) {
              setErr(r.error ?? 'Screenshot failed');
            } else {
              setErr('');
              onChange();
            }
          }}
        >
          Screenshot
        </button>
        <button className="ghost" onClick={async () => (await bg.clearSession(), onChange())}>
          Clear
        </button>
        <button
          className="ghost"
          disabled={session.events.length === 0}
          onClick={() => downloadJson(`${session.id}.json`, session)}
        >
          Export JSON
        </button>
        <button
          className="ghost"
          disabled={session.events.length === 0}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(buildSessionMarkdown(session));
              setErr('');
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setErr('Copy to clipboard failed');
            }
          }}
        >
          Copy events
        </button>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <span className="chip">{session.events.length} actions</span>
        <span className="chip">{session.evidence.length} screenshots</span>
        <span className="chip">{session.consoleErrors.length} console</span>
        <span className="chip">{session.networkFailures.length} network</span>
      </div>

      {copied && (
        <div className="row">
          <span className="ok">Copied to clipboard</span>
        </div>
      )}

      {err && (
        <div className="row">
          <span className="err">{err}</span>
          <button className="ghost" onClick={() => bg.openExtensionSettings()}>
            Open extension settings
          </button>
        </div>
      )}

      <h3>Timeline</h3>
      {session.events.length === 0 ? (
        <p className="muted">No actions recorded yet.</p>
      ) : (
        <ul className="timeline">
          {session.events.map((e) => (
            <li key={e.id}>
              <span className="type">{e.type}</span>
              {e.targetLabel ? ` → ${e.targetLabel}` : ''}
              {e.valueType === 'sensitive'
                ? ' (value hidden)'
                : (e.valueText ?? e.value)
                  ? `: ${e.valueText ?? e.value}`
                  : ''}
              {e.resultSummary && <div className="muted">{e.resultSummary}</div>}
            </li>
          ))}
        </ul>
      )}

      {screenshots.length > 0 && (
        <>
          <h3>Screenshots</h3>
          <div className="shots">
            {screenshots.map((e) => (
              <figure key={e.id} className="shot">
                <img className="thumb" src={e.dataUrl} alt={`Screenshot ${e.capturedAt}`} />
                <figcaption className="muted">
                  {new Date(e.capturedAt).toLocaleTimeString()}
                </figcaption>
              </figure>
            ))}
          </div>
        </>
      )}

      {session.consoleErrors.length > 0 && (
        <>
          <h3>Console errors</h3>
          <ul className="tight">
            {session.consoleErrors.slice(-8).map((c, i) => (
              <li key={i} className="muted">
                [{c.level}] {c.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function GenerateTab({ state, settings }: { state: PanelState; settings: Settings | null }) {
  const [note, setNote] = useState('');
  const [tc, setTc] = useState<GenerateResponse | null>(null);
  const [bug, setBug] = useState<GenerateResponse | null>(null);
  const [pw, setPw] = useState<GenerateResponse | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!settings) return <p className="muted">Loading settings…</p>;

  return (
    <div className="section">
      <h3>Test cases</h3>
      <button
        className="primary"
        disabled={!state.pageModel || busy !== null}
        onClick={() =>
          run('tc', async () => {
            setTc(
              await generateTestCases(settings.backendUrl, {
                pageModel: state.pageModel!,
                format: 'manual_markdown',
              }),
            );
          })
        }
      >
        {busy === 'tc' ? 'Generating…' : 'Generate test cases'}
      </button>
      {tc && (
        <ArtifactView
          title="Test cases"
          res={tc}
          onExport={() => downloadMarkdown(`test-cases-${tc.artifactId}.md`, tc.content)}
          onPreview={() => previewMarkdown('Test cases', tc.content)}
        />
      )}

      <h3>Bug report</h3>
      <textarea
        rows={2}
        placeholder="Expected behavior / note (e.g. Expected release date to default from requested delivery date)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button
        className="primary"
        style={{ marginTop: 6 }}
        disabled={busy !== null || state.session.events.length === 0}
        onClick={() =>
          run('bug', async () => {
            setBug(
              await generateBugReport(settings.backendUrl, {
                session: state.session,
                pageModel: state.pageModel,
                userNote: note,
                includeConsoleErrors: true,
                includeNetworkFailures: true,
              }),
            );
          })
        }
      >
        {busy === 'bug' ? 'Generating…' : 'Generate bug report'}
      </button>
      {bug && (
        <ArtifactView
          title="Bug report"
          res={bug}
          onExport={() => downloadMarkdown(`bug-report-${bug.artifactId}.md`, bug.content)}
          onPreview={() => previewMarkdown('Bug report', bug.content)}
        />
      )}

      <h3>Playwright test</h3>
      <button
        className="primary"
        disabled={busy !== null || state.session.events.length === 0}
        onClick={() =>
          run('pw', async () => {
            setPw(await generatePlaywright(settings.backendUrl, { session: state.session }));
          })
        }
      >
        {busy === 'pw' ? 'Generating…' : 'Generate Playwright draft'}
      </button>
      {pw && (
        <ArtifactView
          title="Playwright draft"
          res={pw}
          onExport={() => downloadTypeScript(pw.filename ?? 'test.spec.ts', pw.content)}
        />
      )}

      {err && <p className="err">{err}</p>}
    </div>
  );
}

function ArtifactView({
  title,
  res,
  onExport,
  onPreview,
}: {
  title: string;
  res: GenerateResponse;
  onExport: () => void;
  onPreview?: () => void;
}) {
  return (
    <div>
      <div className="row" style={{ marginTop: 6 }}>
        <b>{title}</b>
        <span className="draft-tag">DRAFT — review before use</span>
        <button className="ghost" onClick={onExport}>
          Export
        </button>
        {onPreview && (
          <button className="ghost" onClick={onPreview}>
            Preview
          </button>
        )}
      </div>
      {res.selectorWarnings && res.selectorWarnings.length > 0 && (
        <div className="warn">
          {res.selectorWarnings.length} fragile selector(s) flagged — review before adding to a suite.
        </div>
      )}
      <pre className="artifact">{res.content}</pre>
    </div>
  );
}
