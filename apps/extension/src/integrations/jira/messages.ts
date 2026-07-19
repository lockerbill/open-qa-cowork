/**
 * Service-worker message contract for Jira.
 *
 * The side panel and options page never call Jira directly — they message the
 * background worker, which owns the credentials (design.md Decision 1). Payloads
 * are validated by hand rather than with zod: the extension has no zod
 * dependency, and these shapes are small and fully under our control.
 *
 * Blobs cannot survive `chrome.runtime.sendMessage`, so the panel names what to
 * attach and the worker builds the files itself from the stored session.
 */
import type { JiraConfig, Priority, TestSession, TrackerLink } from '@qa-copilot/shared';
import {
  getJiraConfig,
  getSession,
  getTrackerLinks,
  saveJiraConfig,
  saveTrackerLink,
} from '../../shared/storage.js';
import { BasicTokenAuth, normalizeSiteUrl } from './auth.js';
import {
  JiraClient,
  JiraError,
  type AttachmentInput,
  type AttachmentResult,
  type CreateIssuePayload,
  type JiraErrorCode,
  type JiraFieldMeta,
  type JiraUser,
} from './client.js';

/** Config as rendered by the options page — the API token is never projected. */
export interface JiraConfigProjection {
  siteUrl: string;
  email: string;
  projectKey: string;
  issueTypeId: string;
  priorityMap: Record<Priority, string>;
  verified: boolean;
  /** True when a token is stored; the options page then treats blank as "unchanged". */
  hasToken: boolean;
}

export interface JiraCreateIssueRequest {
  artifactId: string;
  payload: CreateIssuePayload;
  attachSession: boolean;
  playwrightSpec: { filename: string; content: string } | null;
}

export interface JiraCreateIssueResult {
  link: TrackerLink;
  attachments: AttachmentResult[];
}

export type JiraMessage =
  | { type: 'JIRA_GET_CONFIG' }
  | { type: 'JIRA_SAVE_CONFIG'; config: JiraConfig }
  | { type: 'JIRA_TEST_CONNECTION'; config: JiraConfig }
  | { type: 'JIRA_GET_CREATE_META' }
  | { type: 'JIRA_GET_LINKS' }
  | { type: 'JIRA_CREATE_ISSUE'; request: JiraCreateIssueRequest };

export const JIRA_MESSAGE_TYPES: readonly JiraMessage['type'][] = [
  'JIRA_GET_CONFIG',
  'JIRA_SAVE_CONFIG',
  'JIRA_TEST_CONNECTION',
  'JIRA_GET_CREATE_META',
  'JIRA_GET_LINKS',
  'JIRA_CREATE_ISSUE',
];

export type JiraResponse<T> =
  | { ok: true; data: T }
  | { ok: false; code: JiraErrorCode | 'invalid_request' | 'not_configured'; message: string; fieldErrors: Record<string, string> };

function ok<T>(data: T): JiraResponse<T> {
  return { ok: true, data };
}

function fail(
  code: JiraErrorCode | 'invalid_request' | 'not_configured',
  message: string,
  fieldErrors: Record<string, string> = {},
): JiraResponse<never> {
  return { ok: false, code, message, fieldErrors };
}

/** Translate anything thrown by the client into a response the panel can render. */
function failFrom(err: unknown): JiraResponse<never> {
  if (err instanceof JiraError) return fail(err.code, err.message, err.fieldErrors);
  return fail('unknown', err instanceof Error ? err.message : String(err));
}

const DEFAULT_PRIORITY_MAP: Record<Priority, string> = {
  critical: 'Highest',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * Validate a config coming over the message boundary. Returns the reason it is
 * unusable, or null when it is fine — so callers can surface a specific message.
 */
export function validateJiraConfig(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'Jira settings are missing.';
  const c = value as Partial<JiraConfig>;
  if (!isNonEmptyString(c.siteUrl)) return 'Site URL is required.';
  if (!normalizeSiteUrl(c.siteUrl)) return 'Site URL is not a valid Jira site address.';
  if (!isNonEmptyString(c.email)) return 'Account email is required.';
  if (!isNonEmptyString(c.apiToken)) return 'API token is required.';
  return null;
}

function projectConfig(config: JiraConfig | null): JiraConfigProjection | null {
  if (!config) return null;
  return {
    siteUrl: config.siteUrl,
    email: config.email,
    projectKey: config.projectKey,
    issueTypeId: config.issueTypeId,
    priorityMap: config.priorityMap ?? DEFAULT_PRIORITY_MAP,
    verified: Boolean(config.verified),
    hasToken: isNonEmptyString(config.apiToken),
  };
}

/**
 * Merge an incoming config over the stored one. A blank token means "keep the
 * stored token", so the options page never has to round-trip the secret.
 */
async function resolveConfig(incoming: JiraConfig): Promise<JiraConfig> {
  const stored = await getJiraConfig();
  return {
    ...incoming,
    siteUrl: normalizeSiteUrl(incoming.siteUrl),
    apiToken: isNonEmptyString(incoming.apiToken) ? incoming.apiToken : (stored?.apiToken ?? ''),
    priorityMap: incoming.priorityMap ?? stored?.priorityMap ?? DEFAULT_PRIORITY_MAP,
    verified: false,
  };
}

function clientFor(config: JiraConfig): JiraClient {
  return new JiraClient(new BasicTokenAuth(config));
}

/** Decode a `data:` URL without going through fetch, which MV3 workers restrict. */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!match) return null;
  const mime = match[1] || 'application/octet-stream';
  const data = match[3] ?? '';
  if (!match[2]) return new Blob([decodeURIComponent(data)], { type: mime });
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

/**
 * Assemble evidence files for an issue. Screenshots come from the recorded
 * session rather than the message, since their data URLs are already stored.
 */
export function buildAttachments(session: TestSession, request: JiraCreateIssueRequest): AttachmentInput[] {
  const files: AttachmentInput[] = [];

  let index = 1;
  for (const item of session.evidence) {
    if (item.type !== 'screenshot' || !item.dataUrl) continue;
    const blob = dataUrlToBlob(item.dataUrl);
    if (!blob) continue;
    files.push({ filename: `screenshot-${index}.png`, blob });
    index += 1;
  }

  if (request.attachSession) {
    files.push({
      filename: `session-${session.id}.json`,
      blob: new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' }),
    });
  }

  if (request.playwrightSpec) {
    files.push({
      filename: request.playwrightSpec.filename,
      blob: new Blob([request.playwrightSpec.content], { type: 'text/plain' }),
    });
  }

  return files;
}

async function requireConfig(): Promise<JiraConfig | JiraResponse<never>> {
  const config = await getJiraConfig();
  if (!config || !isNonEmptyString(config.apiToken)) {
    return fail('not_configured', 'Connect a Jira site in extension settings first.');
  }
  return config;
}

export async function handleJiraMessage(msg: JiraMessage): Promise<JiraResponse<unknown>> {
  switch (msg.type) {
    case 'JIRA_GET_CONFIG':
      return ok(projectConfig(await getJiraConfig()));

    case 'JIRA_GET_LINKS':
      return ok(await getTrackerLinks());

    case 'JIRA_TEST_CONNECTION':
    case 'JIRA_SAVE_CONFIG': {
      const invalid = validateJiraConfig({ ...msg.config, apiToken: msg.config.apiToken || 'placeholder' });
      if (invalid) return fail('invalid_request', invalid);

      const config = await resolveConfig(msg.config);
      if (!isNonEmptyString(config.apiToken)) return fail('invalid_request', 'API token is required.');

      // Only *check* the permission here. chrome.permissions.request throws
      // "must be called during a user gesture" inside a service worker, so the
      // request itself belongs to the options page click that got us here
      // (see requestJiraOrigin). The grant is always a single origin; the broad
      // manifest patterns exist solely to make it grantable (design.md
      // Decision 4).
      const granted = await chrome.permissions
        .contains({ origins: [`${config.siteUrl}/*`] })
        .catch(() => false);
      if (!granted) {
        return fail(
          'forbidden',
          `QA Copilot does not have permission to access ${config.siteUrl}. Grant it when prompted, then try again.`,
        );
      }

      let user: JiraUser;
      try {
        user = await clientFor(config).myself();
      } catch (err) {
        return failFrom(err);
      }

      if (msg.type === 'JIRA_SAVE_CONFIG') await saveJiraConfig({ ...config, verified: true });
      return ok({ user, config: projectConfig({ ...config, verified: true }) });
    }

    case 'JIRA_GET_CREATE_META': {
      const config = await requireConfig();
      if ('ok' in config) return config;
      try {
        const fields: JiraFieldMeta[] = await clientFor(config).getCreateMeta(
          config.projectKey,
          config.issueTypeId,
        );
        return ok(fields);
      } catch (err) {
        return failFrom(err);
      }
    }

    case 'JIRA_CREATE_ISSUE': {
      const config = await requireConfig();
      if ('ok' in config) return config;

      const { request } = msg;
      if (!isNonEmptyString(request?.artifactId)) return fail('invalid_request', 'Missing artifact id.');
      if (!isNonEmptyString(request.payload?.fields?.summary)) {
        return fail('invalid_request', 'Summary is required.', { summary: 'Summary is required.' });
      }

      const jira = clientFor(config);
      let created;
      try {
        created = await jira.createIssue(request.payload);
      } catch (err) {
        return failFrom(err);
      }

      // The issue exists from here on. Attachment problems are reported, never
      // raised — losing the link would be worse than losing an attachment.
      const link: TrackerLink = {
        type: 'jira',
        issueKey: created.key,
        url: created.url,
        createdAt: new Date().toISOString(),
      };
      await saveTrackerLink(request.artifactId, link);

      const session = await getSession();
      const attachments = await jira.addAttachments(created.key, buildAttachments(session, request));
      return ok({ link, attachments } satisfies JiraCreateIssueResult);
    }
  }
}
