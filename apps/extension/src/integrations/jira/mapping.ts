/**
 * Generated bug-report markdown -> a Jira create-issue payload.
 *
 * The gateway returns the report as markdown, not as a structured object, so
 * the summary and severity are recovered from the document itself. Extraction
 * is deliberately forgiving: the model is prompted for a section list (see
 * `bugReportSystem()` in apps/server) but is not constrained to it, and a
 * missing field must degrade rather than block the export.
 */
import type { JiraConfig, Priority } from '@qa-copilot/shared';
import { markdownToAdf } from './adf.js';
import type { CreateIssuePayload } from './client.js';

/** Jira's hard limit on the summary field. */
export const SUMMARY_MAX_LENGTH = 255;

/** Applied to every exported issue so they can be found with one JQL query. */
export const OPENQA_LABEL = 'openqa';

const SEVERITIES: Priority[] = ['critical', 'high', 'medium', 'low'];

/** Strip inline markdown so a heading reads cleanly as a Jira summary. */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .trim();
}

/**
 * Recover the issue summary: the first level-1 heading, else an explicit
 * `Title:` line, else the first line with any content.
 */
export function extractSummary(md: string): string {
  const lines = (md ?? '').split('\n');

  const heading = lines.find((line) => /^#\s+\S/.test(line));
  if (heading) return truncateSummary(stripInlineMarkdown(heading.replace(/^#\s+/, '')));

  const titleLine = lines.find((line) => /^\s*\**\s*title\s*\**\s*:/i.test(line));
  if (titleLine) {
    const value = titleLine.replace(/^\s*\**\s*title\s*\**\s*:/i, '');
    const cleaned = stripInlineMarkdown(value);
    if (cleaned) return truncateSummary(cleaned);
  }

  const firstContent = lines.map((l) => stripInlineMarkdown(l.replace(/^#+\s*/, ''))).find(Boolean);
  return truncateSummary(firstContent ?? 'Bug report');
}

export function truncateSummary(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= SUMMARY_MAX_LENGTH
    ? collapsed
    : collapsed.slice(0, SUMMARY_MAX_LENGTH).trimEnd();
}

/**
 * Recover the severity from either a `Severity: critical` line or a
 * `| Severity | critical |` table row. Returns null when absent, so callers can
 * leave priority unset rather than guessing.
 */
export function extractSeverity(md: string): Priority | null {
  const line = /^[\s|]*\**\s*severity\s*\**\s*[:|]\s*\**\s*([A-Za-z]+)/im.exec(md ?? '');
  const found = line?.[1]?.toLowerCase();
  return SEVERITIES.find((s) => s === found) ?? null;
}

export interface MapReportOptions {
  config: Pick<JiraConfig, 'projectKey' | 'issueTypeId' | 'priorityMap'>;
  /** Overrides from the composer, applied after everything derived. */
  overrides?: {
    summary?: string;
    labels?: string[];
    priorityName?: string | null;
    extraFields?: Record<string, unknown>;
  };
}

/** Build the payload the composer pre-fills from, before the user edits it. */
export function mapReportToIssue(md: string, options: MapReportOptions): CreateIssuePayload {
  const { config, overrides } = options;
  const severity = extractSeverity(md);
  const derivedPriority = severity ? config.priorityMap?.[severity] : undefined;
  const priorityName = overrides?.priorityName === undefined ? derivedPriority : overrides.priorityName;

  const labels = overrides?.labels ?? [OPENQA_LABEL];

  const payload: CreateIssuePayload = {
    fields: {
      project: { key: config.projectKey },
      issuetype: { id: config.issueTypeId },
      summary: truncateSummary(overrides?.summary ?? extractSummary(md)),
      description: markdownToAdf(md),
      labels,
      ...overrides?.extraFields,
    },
  };

  if (priorityName) payload.fields.priority = { name: priorityName };
  return payload;
}
