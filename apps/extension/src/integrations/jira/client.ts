/**
 * Jira Cloud REST v3 client.
 *
 * Runs in the background service worker and talks to the user's Jira site
 * directly — never through `apps/server` (design.md Decision 1). Extension
 * fetches with a granted host permission are exempt from CORS, so no proxy is
 * needed and the API token never leaves the browser profile.
 *
 * Failures surface as `JiraError` with a `code` the UI can turn into the
 * actionable guidance the jira-integration spec ("Error surfaces") requires.
 */
import type { AuthStrategy } from './auth.js';
import type { AdfDoc } from './adf.js';

export type JiraErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'too_large'
  | 'rate_limited'
  | 'network'
  | 'server'
  | 'unknown';

export class JiraError extends Error {
  readonly code: JiraErrorCode;
  readonly status: number;
  /** Per-field messages from Jira, e.g. `{ summary: "must not be empty" }`. */
  readonly fieldErrors: Record<string, string>;
  /** Top-level messages Jira returned alongside any field errors. */
  readonly messages: string[];

  constructor(
    code: JiraErrorCode,
    status: number,
    message: string,
    fieldErrors: Record<string, string> = {},
    messages: string[] = [],
  ) {
    super(message);
    this.name = 'JiraError';
    this.code = code;
    this.status = status;
    this.fieldErrors = fieldErrors;
    this.messages = messages;
  }
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  avatarUrls?: Record<string, string>;
}

/** One field as described by createmeta — drives which composer inputs render. */
export interface JiraFieldMeta {
  fieldId: string;
  name: string;
  required: boolean;
  schemaType: string;
  allowedValues?: { id?: string; value?: string; name?: string }[];
}

export interface CreateIssueFields {
  project: { key: string };
  issuetype: { id: string };
  summary: string;
  description: AdfDoc;
  labels?: string[];
  priority?: { name: string };
  [field: string]: unknown;
}

export interface CreateIssuePayload {
  fields: CreateIssueFields;
}

export interface CreatedIssue {
  id: string;
  key: string;
  /** Browse URL, derived from the configured site — Jira returns only the API self link. */
  url: string;
}

export interface AttachmentInput {
  filename: string;
  blob: Blob;
}

export interface AttachmentResult {
  filename: string;
  ok: boolean;
  /** Present when `ok` is false — already translated for display. */
  error?: string;
}

/** Jira Cloud's default per-file cap. Sites can lower it; we only pre-empt the default. */
export const DEFAULT_ATTACHMENT_LIMIT_BYTES = 10 * 1024 * 1024;

interface JiraErrorBody {
  errorMessages?: string[];
  errors?: Record<string, string>;
}

function parseErrorBody(text: string): JiraErrorBody {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as JiraErrorBody) : {};
  } catch {
    return {};
  }
}

function codeForStatus(status: number): JiraErrorCode {
  if (status === 400) return 'validation';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'unknown';
}

/** Default guidance per failure mode; the composer may override with context. */
function defaultMessage(code: JiraErrorCode, status: number): string {
  switch (code) {
    case 'unauthorized':
      return 'Jira rejected the credentials. The API token may have expired — Atlassian tokens issued since late 2024 expire within a year.';
    case 'forbidden':
      return 'Your Jira account lacks permission for this action. The project needs Browse Projects, Create Issues, and Create Attachments.';
    case 'not_found':
      return 'Jira could not find that project or issue type. Check the project key in Jira settings.';
    case 'validation':
      return 'Jira rejected the issue fields.';
    case 'too_large':
      return 'The file is larger than the Jira site allows.';
    case 'rate_limited':
      return 'Jira is rate limiting this account. Try again shortly.';
    case 'server':
      return `Jira returned a server error (${status}). This is usually temporary.`;
    default:
      return `Jira request failed (${status}).`;
  }
}

function toJiraError(status: number, bodyText: string): JiraError {
  const code = codeForStatus(status);
  const body = parseErrorBody(bodyText);
  const fieldErrors = body.errors ?? {};
  const messages = body.errorMessages ?? [];
  const message = messages[0] ?? Object.values(fieldErrors)[0] ?? defaultMessage(code, status);
  return new JiraError(code, status, message, fieldErrors, messages);
}

/**
 * Retry-After is seconds or an HTTP date. Falls back to 1s and is capped so a
 * hostile or misconfigured header cannot wedge the service worker.
 */
function retryAfterMs(header: string | null): number {
  if (!header) return 1000;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 60) * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 60_000);
  return 1000;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface JiraClientOptions {
  /** Injectable so retry tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

export class JiraClient {
  private readonly auth: AuthStrategy;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(auth: AuthStrategy, options: JiraClientOptions = {}) {
    this.auth = auth;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * One REST call. Honours a single automatic retry on 429 per the spec; every
   * other failure is translated and thrown.
   */
  private async request(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const url = `${this.auth.getBaseUrl()}${path}`;
    let response: Response;
    try {
      response = await fetch(url, { ...init, headers: { ...this.auth.getHeaders(), ...init.headers } });
    } catch (err) {
      throw new JiraError(
        'network',
        0,
        `Could not reach Jira. Check your connection and that ${this.auth.getBaseUrl()} is correct.`,
        {},
        [err instanceof Error ? err.message : String(err)],
      );
    }

    if (response.status === 429 && !retried) {
      await this.sleep(retryAfterMs(response.headers.get('Retry-After')));
      return this.request(path, init, true);
    }

    if (!response.ok) throw toJiraError(response.status, await response.text().catch(() => ''));
    return response;
  }

  private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    return (await response.json()) as T;
  }

  /** Verify credentials and identify the account ("Test connection"). */
  async myself(): Promise<JiraUser> {
    return this.requestJson<JiraUser>('/rest/api/3/myself');
  }

  /**
   * Field metadata for one project + issue type. Drives which composer inputs
   * render, so required custom fields on a customized project surface as inputs
   * rather than as a submit-time failure.
   */
  async getCreateMeta(projectKey: string, issueTypeId: string): Promise<JiraFieldMeta[]> {
    const path = `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}`;
    const body = await this.requestJson<{ fields?: unknown[] }>(path);
    const fields = Array.isArray(body.fields) ? body.fields : [];
    return fields.map((raw) => {
      const f = raw as {
        fieldId?: string;
        key?: string;
        name?: string;
        required?: boolean;
        schema?: { type?: string };
        allowedValues?: { id?: string; value?: string; name?: string }[];
      };
      return {
        fieldId: f.fieldId ?? f.key ?? '',
        name: f.name ?? f.fieldId ?? '',
        required: Boolean(f.required),
        schemaType: f.schema?.type ?? 'string',
        allowedValues: f.allowedValues,
      };
    });
  }

  async createIssue(payload: CreateIssuePayload): Promise<CreatedIssue> {
    const created = await this.requestJson<{ id: string; key: string }>('/rest/api/3/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return {
      id: created.id,
      key: created.key,
      url: `${this.auth.getBaseUrl()}/browse/${created.key}`,
    };
  }

  /**
   * Upload evidence, one request per file so a single rejection can be reported
   * against the file that caused it. Never throws: attachment failure after a
   * successful create must not fail the export (spec, "Attachment failure after
   * issue creation").
   */
  async addAttachments(
    issueKey: string,
    files: AttachmentInput[],
    limitBytes = DEFAULT_ATTACHMENT_LIMIT_BYTES,
  ): Promise<AttachmentResult[]> {
    const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`;
    const results: AttachmentResult[] = [];

    for (const file of files) {
      if (file.blob.size > limitBytes) {
        results.push({
          filename: file.filename,
          ok: false,
          error: `Skipped — ${Math.ceil(file.blob.size / 1024 / 1024)} MB exceeds the ${Math.floor(limitBytes / 1024 / 1024)} MB attachment limit.`,
        });
        continue;
      }

      const form = new FormData();
      form.append('file', file.blob, file.filename);
      try {
        // XSRF check must be disabled explicitly for this endpoint. Content-Type
        // is deliberately unset so fetch adds the multipart boundary itself.
        await this.request(path, {
          method: 'POST',
          headers: { 'X-Atlassian-Token': 'no-check' },
          body: form,
        });
        results.push({ filename: file.filename, ok: true });
      } catch (err) {
        results.push({
          filename: file.filename,
          ok: false,
          error: err instanceof JiraError ? err.message : String(err),
        });
      }
    }

    return results;
  }
}
