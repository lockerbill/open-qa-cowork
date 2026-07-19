/**
 * Jira export UI for a generated bug report.
 *
 * `JiraAction` is the affordance on the report card; `IssueComposer` is the
 * reviewed, pre-filled form that opens from it. Nothing is written to Jira
 * until the user confirms — issue creation is always a human gesture
 * (jira-integration spec, "Create issue from bug report").
 */
import { useCallback, useEffect, useState } from 'react';
import type { TrackerLink } from '@qa-copilot/shared';
import * as bg from './chrome-client.js';
import type { AttachmentResult, JiraFieldMeta } from '../integrations/jira/client.js';
import type { JiraConfigProjection } from '../integrations/jira/messages.js';
import { mapReportToIssue } from '../integrations/jira/mapping.js';

/** Fields the composer fills itself; anything else required comes from createmeta. */
const MAPPED_FIELDS = new Set([
  'project',
  'issuetype',
  'summary',
  'description',
  'labels',
  'priority',
  'reporter',
  'attachment',
  'issuelinks',
]);

export interface JiraExportSource {
  artifactId: string;
  markdown: string;
  playwrightSpec: { filename: string; content: string } | null;
}

/**
 * Shape a dynamic field value the way Jira's schema expects. Options are sent
 * by id; free-text and numeric fields go through as typed.
 */
function shapeFieldValue(field: JiraFieldMeta, raw: string): unknown {
  if (!raw) return undefined;
  const option = field.allowedValues?.find((v) => v.id === raw || v.value === raw || v.name === raw);
  if (option) return field.schemaType === 'array' ? [{ id: option.id }] : { id: option.id };
  if (field.schemaType === 'array') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (field.schemaType === 'number') return Number(raw);
  return raw;
}

export function JiraAction({ source }: { source: JiraExportSource }) {
  const [link, setLink] = useState<TrackerLink | null>(null);
  const [composing, setComposing] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refreshLink = useCallback(async () => {
    const res = await bg.jiraGetLinks();
    if (res.ok) setLink(res.data[source.artifactId] ?? null);
    setLoaded(true);
  }, [source.artifactId]);

  useEffect(() => {
    void refreshLink();
  }, [refreshLink]);

  if (!loaded) return null;

  if (link && !composing) {
    return (
      <>
        <a className="chip ok" href={link.url} target="_blank" rel="noreferrer">
          Open {link.issueKey}
        </a>
        <button className="ghost" title="More actions" onClick={() => setShowOverflow((v) => !v)}>
          ⋯
        </button>
        {showOverflow && (
          <button
            className="ghost"
            onClick={() => {
              setShowOverflow(false);
              setComposing(true);
            }}
          >
            Create another issue
          </button>
        )}
      </>
    );
  }

  return (
    <>
      <button className="ghost" onClick={() => setComposing(true)}>
        Create Jira issue
      </button>
      {composing && (
        <IssueComposer
          source={source}
          onClose={() => setComposing(false)}
          onCreated={() => {
            setComposing(false);
            void refreshLink();
          }}
        />
      )}
    </>
  );
}

function IssueComposer({
  source,
  onClose,
  onCreated,
}: {
  source: JiraExportSource;
  onClose: () => void;
  onCreated: (link: TrackerLink) => void;
}) {
  const [config, setConfig] = useState<JiraConfigProjection | null>(null);
  const [ready, setReady] = useState(false);
  const [summary, setSummary] = useState('');
  const [labels, setLabels] = useState('openqa');
  const [priority, setPriority] = useState('');
  const [extraFields, setExtraFields] = useState<JiraFieldMeta[]>([]);
  const [extraValues, setExtraValues] = useState<Record<string, string>>({});
  const [attachSession, setAttachSession] = useState(true);
  const [attachSpec, setAttachSpec] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ link: TrackerLink; attachments: AttachmentResult[] } | null>(null);

  useEffect(() => {
    void (async () => {
      const configRes = await bg.jiraGetConfig();
      const stored = configRes.ok ? configRes.data : null;
      setConfig(stored);
      if (!stored?.verified) {
        setReady(true);
        return;
      }

      const prefill = mapReportToIssue(source.markdown, {
        config: {
          projectKey: stored.projectKey,
          issueTypeId: stored.issueTypeId,
          priorityMap: stored.priorityMap,
        },
      });
      setSummary(prefill.fields.summary);
      setLabels((prefill.fields.labels ?? []).join(', '));
      setPriority(prefill.fields.priority?.name ?? '');

      // Required fields this project adds that the composer does not map are
      // rendered as inputs, so a customized project fails here rather than at
      // submit time (jira-integration spec, "Field validation error").
      const metaRes = await bg.jiraGetCreateMeta();
      if (metaRes.ok) {
        setExtraFields(metaRes.data.filter((f) => f.required && !MAPPED_FIELDS.has(f.fieldId)));
      }
      setReady(true);
    })();
  }, [source.markdown]);

  const create = async () => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const extras: Record<string, unknown> = {};
      for (const field of extraFields) {
        const shaped = shapeFieldValue(field, extraValues[field.fieldId] ?? '');
        if (shaped !== undefined) extras[field.fieldId] = shaped;
      }

      const payload = mapReportToIssue(source.markdown, {
        config: {
          projectKey: config!.projectKey,
          issueTypeId: config!.issueTypeId,
          priorityMap: config!.priorityMap,
        },
        overrides: {
          summary,
          labels: labels.split(',').map((s) => s.trim()).filter(Boolean),
          priorityName: priority || null,
          extraFields: extras,
        },
      });

      const res = await bg.jiraCreateIssue({
        artifactId: source.artifactId,
        payload,
        attachSession,
        playwrightSpec: attachSpec ? source.playwrightSpec : null,
      });

      if (res.ok) {
        setResult(res.data);
        onCreated(res.data.link);
      } else {
        // The composer stays open with the user's input intact.
        setError(res.message);
        setFieldErrors(res.fieldErrors);
      }
    } finally {
      setBusy(false);
    }
  };

  if (!ready) return <p className="muted">Loading Jira settings…</p>;

  if (!config?.verified) {
    return (
      <div className="section">
        <p className="muted">Connect a Jira site before exporting a report.</p>
        <div className="row">
          <button className="primary" onClick={() => void bg.openExtensionSettings()}>
            Open Jira settings
          </button>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (result) {
    const failed = result.attachments.filter((a) => !a.ok);
    return (
      <div className="section">
        <p>
          Created{' '}
          <a href={result.link.url} target="_blank" rel="noreferrer">
            {result.link.issueKey}
          </a>{' '}
          with {result.attachments.filter((a) => a.ok).length} attachment(s).
        </p>
        {failed.length > 0 && (
          <div className="warn">
            {failed.length} attachment(s) failed:
            <ul className="tight">
              {failed.map((a) => (
                <li key={a.filename}>
                  {a.filename} — {a.error}
                </li>
              ))}
            </ul>
            <button className="ghost" onClick={() => void create()}>
              Retry attachments
            </button>
          </div>
        )}
        <button className="ghost" onClick={onClose}>
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="section">
      <h3>Create Jira issue</h3>
      <p className="muted">
        {config.projectKey} · issue type {config.issueTypeId} · {config.siteUrl}
      </p>

      <label className="muted">Summary</label>
      <input type="text" value={summary} maxLength={255} onChange={(e) => setSummary(e.target.value)} />
      {fieldErrors.summary && <p className="err">{fieldErrors.summary}</p>}

      <label className="muted">Labels (comma separated)</label>
      <input type="text" value={labels} onChange={(e) => setLabels(e.target.value)} />
      {fieldErrors.labels && <p className="err">{fieldErrors.labels}</p>}

      <label className="muted">Priority</label>
      <input
        type="text"
        value={priority}
        placeholder="(leave blank to use the project default)"
        onChange={(e) => setPriority(e.target.value)}
      />
      {fieldErrors.priority && <p className="err">{fieldErrors.priority}</p>}

      {extraFields.map((field) => (
        <div key={field.fieldId}>
          <label className="muted">{field.name} (required)</label>
          {field.allowedValues && field.allowedValues.length > 0 ? (
            <select
              value={extraValues[field.fieldId] ?? ''}
              onChange={(e) => setExtraValues((v) => ({ ...v, [field.fieldId]: e.target.value }))}
            >
              <option value="">—</option>
              {field.allowedValues.map((option) => (
                <option key={option.id ?? option.value} value={option.id ?? ''}>
                  {option.value ?? option.name ?? option.id}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={extraValues[field.fieldId] ?? ''}
              onChange={(e) => setExtraValues((v) => ({ ...v, [field.fieldId]: e.target.value }))}
            />
          )}
          {fieldErrors[field.fieldId] && <p className="err">{fieldErrors[field.fieldId]}</p>}
        </div>
      ))}

      <label className="row">
        <input type="checkbox" checked={attachSession} onChange={(e) => setAttachSession(e.target.checked)} />
        Attach session export (screenshots are always attached)
      </label>
      {source.playwrightSpec && (
        <label className="row">
          <input type="checkbox" checked={attachSpec} onChange={(e) => setAttachSpec(e.target.checked)} />
          Attach {source.playwrightSpec.filename}
        </label>
      )}

      {error && <p className="err">{error}</p>}

      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" disabled={busy || !summary.trim()} onClick={() => void create()}>
          {busy ? 'Creating…' : 'Create'}
        </button>
        <button className="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
