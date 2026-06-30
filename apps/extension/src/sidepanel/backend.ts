import type { PageModel, TestSession } from '@qa-copilot/shared';
import type { AuthState } from '../shared/messages.js';

export interface AnalyzeResponse {
  summary: string;
  risks: string[];
  suggestedTests: string[];
}

export interface GenerateResponse {
  artifactId: string;
  content: string;
  format: string;
  filename?: string;
  selectorWarnings?: { eventId: string; targetLabel?: string; message: string }[];
}

/** Error carrying the gateway's HTTP status and machine-readable `code`. */
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

async function api<T>(
  backendUrl: string,
  path: string,
  opts: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${backendUrl.replace(/\/$/, '')}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let code: string | undefined;
    let message = text || res.statusText;
    try {
      const parsed = JSON.parse(text) as { error?: string; code?: string };
      code = parsed.code;
      message = parsed.error ?? message;
    } catch {
      // non-JSON error body; keep raw text
    }
    throw new ApiClientError(res.status, message, code);
  }
  return (await res.json()) as T;
}

// --- Legacy stateless endpoints (still used as fallback) -------------------

export function analyzePage(
  backendUrl: string,
  payload: { pageModel: PageModel; question?: string; environment?: string },
): Promise<AnalyzeResponse> {
  return api<AnalyzeResponse>(backendUrl, '/api/page/analyze', { body: payload });
}

export function generateTestCases(
  backendUrl: string,
  payload: { pageModel: PageModel; format?: string; focus?: string },
): Promise<GenerateResponse> {
  return api<GenerateResponse>(backendUrl, '/api/generate/test-cases', { body: payload });
}

export function generateBugReport(
  backendUrl: string,
  payload: {
    session: TestSession;
    pageModel: PageModel | null;
    userNote: string;
    includeConsoleErrors?: boolean;
    includeNetworkFailures?: boolean;
  },
): Promise<GenerateResponse> {
  return api<GenerateResponse>(backendUrl, '/api/generate/bug-report', { body: payload });
}

export function generatePlaywright(
  backendUrl: string,
  payload: { session: TestSession; enrich?: boolean },
): Promise<GenerateResponse> {
  return api<GenerateResponse>(backendUrl, '/api/generate/playwright', { body: payload });
}

// --- Multi-user platform endpoints -----------------------------------------

export interface PublicUser {
  id: string;
  email: string;
  displayName: string | null;
}
export interface WorkspaceSummary {
  id: string;
  name: string;
  role: string;
}
export interface AuthResult {
  token: string;
  user: PublicUser;
  workspace?: WorkspaceSummary;
}
export interface ProviderConfigView {
  id: string;
  displayName: string;
  modelName: string;
  baseUrl: string;
  enabled: boolean;
  validationStatus: string;
  isWorkspaceDefault: boolean;
}

export function register(
  backendUrl: string,
  body: { email: string; password: string; displayName?: string },
): Promise<AuthResult> {
  return api<AuthResult>(backendUrl, '/api/auth/register', { body });
}

export function login(
  backendUrl: string,
  body: { email: string; password: string },
): Promise<AuthResult> {
  return api<AuthResult>(backendUrl, '/api/auth/login', { body });
}

export function listWorkspaces(
  backendUrl: string,
  token: string,
): Promise<{ workspaces: WorkspaceSummary[] }> {
  return api(backendUrl, '/api/workspaces', { token });
}

export function listProviders(
  backendUrl: string,
  token: string,
  workspaceId: string,
): Promise<{ providers: ProviderConfigView[] }> {
  return api(backendUrl, `/api/workspaces/${workspaceId}/llm-providers`, { token });
}

export function createProvider(
  backendUrl: string,
  token: string,
  workspaceId: string,
  body: {
    displayName: string;
    baseUrl: string;
    modelName: string;
    apiKey: string;
    maxOutputTokens?: number;
    temperature?: number;
    timeoutSeconds?: number;
  },
): Promise<ProviderConfigView> {
  return api(backendUrl, `/api/workspaces/${workspaceId}/llm-providers`, { token, body });
}

export function validateProvider(
  backendUrl: string,
  token: string,
  workspaceId: string,
  providerId: string,
): Promise<{ status: string; model: string; message: string }> {
  return api(backendUrl, `/api/workspaces/${workspaceId}/llm-providers/${providerId}/validate`, {
    token,
    method: 'POST',
  });
}

export function setDefaultProvider(
  backendUrl: string,
  token: string,
  workspaceId: string,
  providerId: string,
): Promise<{ ok: boolean }> {
  return api(backendUrl, `/api/workspaces/${workspaceId}/llm-providers/${providerId}/set-default`, {
    token,
    method: 'POST',
  });
}

interface GatewayBugReport {
  taskRunId: string;
  bugReport: { content: string; format: string };
  usage: { inputTokens: number | null; outputTokens: number | null };
}

/**
 * Generate a bug report, preferring the workspace-scoped gateway endpoint when
 * the user is signed in. Falls back to the legacy stateless endpoint when not
 * authenticated, or when the workspace has no provider configured / token is
 * rejected — preserving the pre-multi-user behaviour.
 */
export async function generateBugReportSmart(
  backendUrl: string,
  auth: AuthState,
  payload: { session: TestSession; pageModel: PageModel | null; userNote: string },
): Promise<GenerateResponse> {
  if (auth.token && auth.currentWorkspaceId) {
    try {
      const r = await api<GatewayBugReport>(
        backendUrl,
        `/api/workspaces/${auth.currentWorkspaceId}/ai/tasks/generate-bug-report`,
        { token: auth.token, body: payload },
      );
      return { artifactId: r.taskRunId, content: r.bugReport.content, format: r.bugReport.format };
    } catch (err) {
      const fallbackable =
        err instanceof ApiClientError && (err.code === 'no_provider' || err.status === 401);
      if (!fallbackable) throw err;
    }
  }
  return generateBugReport(backendUrl, payload);
}
