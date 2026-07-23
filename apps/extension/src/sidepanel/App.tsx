import { useCallback, useEffect, useState } from 'react';
import { buildSessionMarkdown } from '@qa-copilot/shared';
import type { AuthProjection, PanelState, Settings } from '../shared/messages.js';
import { MANAGE_ROLES, STATE_CHANGED } from '../shared/messages.js';
import * as bg from './chrome-client.js';
import { getAuth } from '../shared/storage.js';
import {
  ApiClientError,
  analyzePageSmart,
  generateBugReportSmart,
  generatePlaywrightSmart,
  generateTestCasesSmart,
  listEnvironments,
  listProjects,
  type AnalyzeResponse,
  type EnvironmentSummary,
  type GenerateResponse,
  type ProjectSummary,
} from './backend.js';
import { downloadJson, downloadMarkdown, downloadTypeScript } from './exports.js';
import { previewMarkdown } from './preview.js';
import { ChatTab } from './ChatTab.js';
import { JiraAction, type JiraExportSource } from './IssueComposer.js';
import { AUTO_TEST_MODE } from '../shared/flags.js';
import { AutoTab } from './auto/AutoTab.js';
import { deriveSuggestedCases } from './auto/setup-logic.js';
import { defectNoteText, type DefectPrefill } from './auto/result-logic.js';

/** Map an AI-task error to a role-aware, user-facing message. */
function explainError(e: unknown, role: string | null): string {
  if (e instanceof ApiClientError) {
    if (e.code === 'no_provider') {
      return MANAGE_ROLES.includes(role ?? '')
        ? 'No AI provider is configured for this workspace. Open Settings → AI Provider to configure one.'
        : 'No AI provider is configured for this workspace. Ask your workspace admin to set one up.';
    }
    if (e.status === 403) return "Your role can't run AI tasks. Ask a workspace admin for access.";
  }
  return (e as Error).message;
}

/** Whether to offer the admin a one-click path to provider settings. */
function showConfigure(e: unknown, role: string | null): boolean {
  return (
    e instanceof ApiClientError && e.code === 'no_provider' && MANAGE_ROLES.includes(role ?? '')
  );
}

type Tab = 'page' | 'session' | 'generate' | 'chat' | 'auto';

export function App() {
  const [state, setState] = useState<PanelState | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tab, setTab] = useState<Tab>('page');
  // Auto tab plumbing (§10, §11): the suggested-case picker feeds off the last
  // analyze/test-cases results; a defect card opens Generate prefilled.
  const [analyze, setAnalyze] = useState<AnalyzeResponse | null>(null);
  const [testCasesMd, setTestCasesMd] = useState<string | null>(null);
  const [defectPrefill, setDefectPrefill] = useState<DefectPrefill | null>(null);

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

      {state.auth.signedIn && settings && <ContextBar auth={state.auth} settings={settings} />}

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
        <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
          Chat
        </button>
        {AUTO_TEST_MODE && (
          <button className={tab === 'auto' ? 'active' : ''} onClick={() => setTab('auto')}>
            Auto
          </button>
        )}
      </nav>

      <div className="content">
        {tab === 'page' && <PageTab state={state} settings={settings} onAnalyzed={setAnalyze} />}
        {tab === 'session' && <SessionTab state={state} onChange={refresh} />}
        {tab === 'generate' && (
          <GenerateTab
            state={state}
            settings={settings}
            defectPrefill={defectPrefill}
            onTestCases={setTestCasesMd}
          />
        )}
        {tab === 'chat' && <ChatTab settings={settings} />}
        {tab === 'auto' && AUTO_TEST_MODE && (
          <AutoTab
            state={state}
            suggestedCases={deriveSuggestedCases(testCasesMd, analyze?.suggestedTests)}
            onGenerateBugReport={(defect) => {
              setDefectPrefill(defect);
              setTab('generate');
            }}
            onOpenGenerate={() => setTab('generate')}
          />
        )}
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

/**
 * Shows the current project/environment context (auto-detected from the tab URL
 * or manually overridden) and lets the user change it or revert to auto-detect.
 */
function ContextBar({ auth, settings }: { auth: AuthProjection; settings: Settings }) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [envs, setEnvs] = useState<EnvironmentSummary[]>([]);
  const [projectId, setProjectId] = useState('');
  const [err, setErr] = useState('');

  const openSelector = async () => {
    setErr('');
    setOpen(true);
    try {
      const a = await getAuth();
      if (!a.token || !a.currentWorkspaceId) return;
      const { projects } = await listProjects(settings.backendUrl, a.token, a.currentWorkspaceId);
      setProjects(projects);
      setProjectId(auth.projectId ?? projects[0]?.id ?? '');
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  useEffect(() => {
    if (!open || !projectId) {
      setEnvs([]);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const a = await getAuth();
        if (!a.token || !a.currentWorkspaceId) return;
        const { environments } = await listEnvironments(
          settings.backendUrl,
          a.token,
          a.currentWorkspaceId,
          projectId,
        );
        if (active) setEnvs(environments);
      } catch (e) {
        if (active) setErr((e as Error).message);
      }
    })();
    return () => {
      active = false;
    };
  }, [open, projectId, settings.backendUrl]);

  const confirm = async (environmentId: string) => {
    const project = projects.find((p) => p.id === projectId);
    const environment = envs.find((e) => e.id === environmentId);
    await bg.setContext({
      projectId: projectId || null,
      projectName: project?.name ?? null,
      environmentId: environmentId || null,
      environmentName: environment?.displayName ?? null,
    });
    setOpen(false);
  };

  const label = auth.projectName
    ? `${auth.projectName}${auth.environmentName ? ` · ${auth.environmentName}` : ''}`
    : 'No project';

  return (
    <div className="context-bar row">
      <span className="chip">{label}</span>
      {auth.contextSource && <span className="muted">({auth.contextSource})</span>}
      {!open ? (
        <>
          <button className="ghost" onClick={openSelector}>
            Change
          </button>
          {auth.contextSource === 'manual' && (
            <button className="ghost" onClick={() => bg.clearContextOverride()}>
              Use auto-detect
            </button>
          )}
          <button className="ghost" onClick={() => bg.resolveActiveTab()}>
            Re-detect
          </button>
        </>
      ) : (
        <>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">— project —</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            defaultValue={auth.environmentId ?? ''}
            onChange={(e) => void confirm(e.target.value)}
            disabled={!projectId}
          >
            <option value="">— environment —</option>
            {envs.map((e) => (
              <option key={e.id} value={e.id}>
                {e.displayName}
              </option>
            ))}
          </select>
          <button className="ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </>
      )}
      {err && <span className="err">{err}</span>}
    </div>
  );
}

function formatAnalyzePreview(answer: AnalyzeResponse): string {
  const lines = ['# AI suggestions', '', answer.summary];

  if (answer.risks.length > 0) {
    lines.push('', '## Risks', ...answer.risks.map((risk) => `- ${risk}`));
  }

  if (answer.suggestedTests.length > 0) {
    lines.push('', '## Suggested tests', ...answer.suggestedTests.map((test) => `- ${test}`));
  }

  return lines.join('\n');
}

function PageTab({
  state,
  settings,
  onAnalyzed,
}: {
  state: PanelState;
  settings: Settings | null;
  /** Mirrors the result up so the Auto tab's suggested-case picker can use it (§10). */
  onAnalyzed: (answer: AnalyzeResponse) => void;
}) {
  const summary = state.pageModel?.summary;
  const [answer, setAnswer] = useState<AnalyzeResponse | null>(null);
  const [err, setErr] = useState('');
  const [canConfig, setCanConfig] = useState(false);
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    if (!state.pageModel || !settings) return;
    setBusy(true);
    setErr('');
    setCanConfig(false);
    try {
      const auth = await getAuth();
      const result = await analyzePageSmart(settings.backendUrl, auth, {
        pageModel: state.pageModel,
        question: 'What should I test on this page?',
        environment: settings.environment,
      });
      setAnswer(result);
      onAnalyzed(result);
    } catch (e) {
      setErr(explainError(e, state.auth.role));
      setCanConfig(showConfigure(e, state.auth.role));
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
        <button
          className="ghost"
          disabled={!answer}
          onClick={() => {
            if (answer) previewMarkdown('AI suggestions', formatAnalyzePreview(answer));
          }}
        >
          Preview
        </button>
      </div>

      {err && (
        <div className="row">
          <span className="err">{err}</span>
          {canConfig && (
            <button className="ghost" onClick={() => bg.openExtensionSettings()}>
              Configure Provider
            </button>
          )}
        </div>
      )}

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
              {e.source === 'auto' && (
                <span className="chip" title="Executed by Auto Test Mode">
                  ⚙
                </span>
              )}
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

function GenerateTab({
  state,
  settings,
  defectPrefill,
  onTestCases,
}: {
  state: PanelState;
  settings: Settings | null;
  /** Auto-run defect card prefill (§11) — seeds the note and the request payload. */
  defectPrefill: DefectPrefill | null;
  /** Mirrors generated test-case markdown up for the Auto tab's picker (§10). */
  onTestCases: (markdown: string) => void;
}) {
  const [note, setNote] = useState('');
  const [tc, setTc] = useState<GenerateResponse | null>(null);
  const [bug, setBug] = useState<GenerateResponse | null>(null);
  const [pw, setPw] = useState<GenerateResponse | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const [canConfig, setCanConfig] = useState(false);

  // A defect card in the Auto tab opens this generator prefilled (§11).
  useEffect(() => {
    if (defectPrefill) setNote(defectNoteText(defectPrefill));
  }, [defectPrefill]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setErr('');
    setCanConfig(false);
    try {
      await fn();
    } catch (e) {
      setErr(explainError(e, state.auth.role));
      setCanConfig(showConfigure(e, state.auth.role));
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
            const auth = await getAuth();
            const result = await generateTestCasesSmart(settings.backendUrl, auth, {
              pageModel: state.pageModel!,
            });
            setTc(result);
            onTestCases(result.content);
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
            const auth = await getAuth();
            setBug(
              await generateBugReportSmart(settings.backendUrl, auth, {
                session: state.session,
                pageModel: state.pageModel,
                userNote: note,
                ...(defectPrefill ? { defect: defectPrefill } : {}),
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
          jira={{
            artifactId: bug.artifactId,
            markdown: bug.content,
            playwrightSpec: pw
              ? { filename: pw.filename ?? 'test.spec.ts', content: pw.content }
              : null,
          }}
        />
      )}

      <h3>Playwright test</h3>
      <button
        className="primary"
        disabled={busy !== null || state.session.events.length === 0}
        onClick={() =>
          run('pw', async () => {
            const auth = await getAuth();
            setPw(await generatePlaywrightSmart(settings.backendUrl, auth, { session: state.session }));
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

      {err && (
        <div className="row">
          <span className="err">{err}</span>
          {canConfig && (
            <button className="ghost" onClick={() => bg.openExtensionSettings()}>
              Configure Provider
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ArtifactView({
  title,
  res,
  onExport,
  onPreview,
  jira,
}: {
  title: string;
  res: GenerateResponse;
  onExport: () => void;
  onPreview?: () => void;
  /** Present only for the bug report, which is the artifact Jira accepts. */
  jira?: JiraExportSource;
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
        {jira && <JiraAction source={jira} />}
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
