import type { PageModel, TestSession } from '@qa-copilot/shared';
import type { AuthState, ResolveMatch } from '../shared/messages.js';

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

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

async function api<T>(
  backendUrl: string,
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    token?: string | null;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${backendUrl.replace(/\/$/, '')}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
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

/** Auto-run defect prefill accepted by the bug-report generator (auto-test-mode-spec §11). */
export interface DefectPayload {
  summary: string;
  expected: string;
  actual: string;
  traceExcerpt: string;
}

export function generateBugReport(
  backendUrl: string,
  payload: {
    session: TestSession;
    pageModel: PageModel | null;
    userNote: string;
    includeConsoleErrors?: boolean;
    includeNetworkFailures?: boolean;
    defect?: DefectPayload;
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

// --- Projects / environments / URL resolution ------------------------------

export interface ProjectSummary {
  id: string;
  key: string;
  name: string;
}
export interface EnvironmentSummary {
  id: string;
  name: string;
  displayName: string;
  baseUrl: string | null;
}

export function listProjects(
  backendUrl: string,
  token: string,
  workspaceId: string,
): Promise<{ projects: ProjectSummary[] }> {
  return api(backendUrl, `/api/workspaces/${workspaceId}/projects`, { token });
}

export function listEnvironments(
  backendUrl: string,
  token: string,
  workspaceId: string,
  projectId: string,
): Promise<{ environments: EnvironmentSummary[] }> {
  return api(backendUrl, `/api/workspaces/${workspaceId}/projects/${projectId}/environments`, {
    token,
  });
}

export function resolveUrl(
  backendUrl: string,
  token: string,
  workspaceId: string,
  url: string,
): Promise<{ match: ResolveMatch | null }> {
  return api(
    backendUrl,
    `/api/workspaces/${workspaceId}/resolve?url=${encodeURIComponent(url)}`,
    { token },
  );
}

// --- Gateway-or-legacy AI tasks --------------------------------------------

/** True when a gateway error should fall back to the legacy stateless endpoint. */
function canFallback(err: unknown): boolean {
  return err instanceof ApiClientError && (err.code === 'no_provider' || err.status === 401);
}

/** Layered-resolution context for a gateway call. Null fields are omitted so
 * the optional Zod schema fields stay absent rather than `null`. */
function ctx(auth: AuthState): { projectId?: string; environmentId?: string } {
  const c: { projectId?: string; environmentId?: string } = {};
  if (auth.currentProjectId) c.projectId = auth.currentProjectId;
  if (auth.currentEnvironmentId) c.environmentId = auth.currentEnvironmentId;
  return c;
}

/** Whether the signed-in session can use the workspace gateway. */
function canUseGateway(auth: AuthState): auth is AuthState & { token: string; currentWorkspaceId: string } {
  return !!auth.token && !!auth.currentWorkspaceId;
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
  payload: {
    session: TestSession;
    pageModel: PageModel | null;
    userNote: string;
    defect?: DefectPayload;
  },
): Promise<GenerateResponse> {
  if (canUseGateway(auth)) {
    try {
      const r = await api<GatewayBugReport>(
        backendUrl,
        `/api/workspaces/${auth.currentWorkspaceId}/ai/tasks/generate-bug-report`,
        { token: auth.token, body: { ...payload, ...ctx(auth) } },
      );
      return { artifactId: r.taskRunId, content: r.bugReport.content, format: r.bugReport.format };
    } catch (err) {
      if (!canFallback(err)) throw err;
    }
  }
  return generateBugReport(backendUrl, payload);
}

/**
 * Analyze the page via the gateway when signed in, else the legacy endpoint.
 * The `analyze-page` route returns the inner result shape directly
 * (`{ summary, risks, suggestedTests }` — no `result` wrapper).
 */
export async function analyzePageSmart(
  backendUrl: string,
  auth: AuthState,
  payload: { pageModel: PageModel; question?: string; environment?: string },
): Promise<AnalyzeResponse> {
  if (canUseGateway(auth)) {
    try {
      return await api<AnalyzeResponse>(
        backendUrl,
        `/api/workspaces/${auth.currentWorkspaceId}/ai/tasks/analyze-page`,
        { token: auth.token, body: { pageModel: payload.pageModel, question: payload.question, ...ctx(auth) } },
      );
    } catch (err) {
      if (!canFallback(err)) throw err;
    }
  }
  return analyzePage(backendUrl, payload);
}

interface GatewayArtifact {
  artifactId: string;
  type: string;
  format: string;
  content: string;
}

/**
 * Generate test cases via the gateway when signed in, else the legacy endpoint.
 * The `generate-test-cases` route returns `{ artifactId, type, format, content }`
 * directly (no `result` wrapper).
 */
export async function generateTestCasesSmart(
  backendUrl: string,
  auth: AuthState,
  payload: { pageModel: PageModel; focus?: string },
): Promise<GenerateResponse> {
  if (canUseGateway(auth)) {
    try {
      const r = await api<GatewayArtifact>(
        backendUrl,
        `/api/workspaces/${auth.currentWorkspaceId}/ai/tasks/generate-test-cases`,
        { token: auth.token, body: { pageModel: payload.pageModel, focus: payload.focus, ...ctx(auth) } },
      );
      return { artifactId: r.artifactId, content: r.content, format: r.format };
    } catch (err) {
      if (!canFallback(err)) throw err;
    }
  }
  return generateTestCases(backendUrl, { pageModel: payload.pageModel, format: 'manual_markdown', focus: payload.focus });
}

/**
 * Generate a Playwright draft via the gateway (`enrich-playwright`) when signed
 * in, else the legacy endpoint. The gateway response already matches
 * GenerateResponse (artifactId, content, format, filename, selectorWarnings).
 */
export async function generatePlaywrightSmart(
  backendUrl: string,
  auth: AuthState,
  payload: { session: TestSession; enrich?: boolean },
): Promise<GenerateResponse> {
  if (canUseGateway(auth)) {
    try {
      return await api<GenerateResponse>(
        backendUrl,
        `/api/workspaces/${auth.currentWorkspaceId}/ai/tasks/enrich-playwright`,
        { token: auth.token, body: { session: payload.session, enrich: payload.enrich, ...ctx(auth) } },
      );
    } catch (err) {
      if (!canFallback(err)) throw err;
    }
  }
  return generatePlaywright(backendUrl, payload);
}

export function sendChatMessage(
  backendUrl: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<{ content: string }> {
  return api<{ content: string }>(backendUrl, '/api/chat', { body: { messages }, signal });
}

/**
 * Chat via the workspace gateway when signed in, else the legacy endpoint.
 *
 * Deliberately does NOT use canFallback(): unlike the generate tasks, a signed-in
 * user with no configured provider gets the `no_provider` error surfaced rather
 * than a silent fall back to the server's env-configured LLM. Answering a chat
 * turn from a different model than the one the user configured is confusing in a
 * way a one-shot generation is not. A 401 (stale token) still falls back.
 */
export async function sendChatMessageSmart(
  backendUrl: string,
  auth: AuthState,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<{ content: string }> {
  if (canUseGateway(auth)) {
    try {
      const r = await api<{ taskRunId: string; content: string }>(
        backendUrl,
        `/api/workspaces/${auth.currentWorkspaceId}/ai/tasks/chat`,
        { token: auth.token, body: { messages, ...ctx(auth) }, signal },
      );
      return { content: r.content };
    } catch (err) {
      if (!(err instanceof ApiClientError && err.status === 401)) throw err;
    }
  }
  return sendChatMessage(backendUrl, messages, signal);
}
