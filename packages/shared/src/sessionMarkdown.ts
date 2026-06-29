import type { ActionEvent, TestSession } from './types.js';

/** Human-readable value for a recorded action, honouring redaction. */
function eventValue(ev: ActionEvent): string {
  if (ev.valueType === 'sensitive') return ' (value hidden)';
  const v = ev.valueText ?? ev.value;
  return v ? `: ${v}` : '';
}

/** One markdown line per recorded step, mirroring the side-panel timeline. */
function stepLine(ev: ActionEvent, index: number): string {
  const target = ev.targetLabel ? ` → ${ev.targetLabel}` : '';
  return `${index + 1}. **${ev.type}**${target}${eventValue(ev)}`;
}

/** Render a timestamp as a readable local string, falling back to the raw value. */
function readableTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Convert a recorded session into a markdown report for pasting into a bug
 * tracker. Includes a metadata header, the action timeline, console errors, and
 * network failures. Empty sections are omitted. Never emits sensitive values.
 */
export function buildSessionMarkdown(session: TestSession): string {
  const out: string[] = ['## QA Session', ''];

  const url = session.currentUrl ?? session.baseUrl;
  const meta: string[] = [];
  if (url) meta.push(`- **URL:** ${url}`);
  if (session.browser) meta.push(`- **Browser:** ${session.browser}`);
  if (session.environment) meta.push(`- **Environment:** ${session.environment}`);
  if (session.startedAt) meta.push(`- **Started:** ${readableTime(session.startedAt)}`);
  if (session.endedAt) meta.push(`- **Ended:** ${readableTime(session.endedAt)}`);
  meta.push(
    `- **Totals:** ${session.events.length} actions, ${session.consoleErrors.length} console, ${session.networkFailures.length} network`,
  );
  out.push(...meta);

  out.push('', '### Steps');
  if (session.events.length === 0) {
    out.push('', '_No actions recorded._');
  } else {
    out.push('');
    session.events.forEach((ev, i) => {
      out.push(stepLine(ev, i));
      if (ev.resultSummary) out.push(`   - _${ev.resultSummary}_`);
    });
  }

  if (session.consoleErrors.length > 0) {
    out.push('', '### Console errors', '');
    for (const c of session.consoleErrors) {
      out.push(`- [${c.level}] ${c.message}`);
    }
  }

  if (session.networkFailures.length > 0) {
    out.push('', '### Network failures', '');
    for (const n of session.networkFailures) {
      const reason = n.reason ? ` (${n.reason})` : '';
      out.push(`- ${n.method} ${n.urlPath} → ${n.status}${reason}`);
    }
  }

  return out.join('\n') + '\n';
}
