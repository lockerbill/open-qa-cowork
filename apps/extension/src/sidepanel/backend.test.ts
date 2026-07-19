import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageModel, TestSession } from '@qa-copilot/shared';
import { EMPTY_AUTH, type AuthState } from '../shared/messages.js';
import {
  analyzePageSmart,
  generateBugReportSmart,
  generatePlaywrightSmart,
  generateTestCasesSmart,
  listEnvironments,
  listProjects,
  resolveUrl,
} from './backend.js';

const BACKEND = 'http://localhost:8787';

const auth: AuthState = {
  ...EMPTY_AUTH,
  token: 'tok',
  currentWorkspaceId: 'ws1',
  currentWorkspaceRole: 'admin',
  currentProjectId: 'proj1',
  currentEnvironmentId: 'env1',
  contextSource: 'auto',
};

const pageModel = { summary: { url: 'http://x' }, elements: [], capturedAt: '' } as unknown as PageModel;
const session = { id: 's1', events: [] } as unknown as TestSession;

/** Build a fetch Response stub. */
function res(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body),
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

/** The (url, init) of the Nth fetch call. */
function call(n = 0): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[n]!;
  return { url, init };
}
function bodyOf(n = 0): Record<string, unknown> {
  return JSON.parse((call(n).init.body as string) ?? '{}');
}

describe('analyzePageSmart', () => {
  it('hits the gateway, sends project/env context, and parses the unwrapped shape', async () => {
    fetchMock.mockResolvedValueOnce(
      res(200, { summary: 'ok', risks: ['r'], suggestedTests: ['t'] }),
    );
    const out = await analyzePageSmart(BACKEND, auth, { pageModel, question: 'q', environment: 'staging' });

    expect(call().url).toBe(`${BACKEND}/api/workspaces/ws1/ai/tasks/analyze-page`);
    const body = bodyOf();
    expect(body.projectId).toBe('proj1');
    expect(body.environmentId).toBe('env1');
    expect(body).not.toHaveProperty('environment'); // dropped for the gateway
    expect(out).toEqual({ summary: 'ok', risks: ['r'], suggestedTests: ['t'] });
  });

  it('falls back to the legacy endpoint on no_provider', async () => {
    fetchMock
      .mockResolvedValueOnce(res(400, { error: 'nope', code: 'no_provider' }))
      .mockResolvedValueOnce(res(200, { summary: 'legacy', risks: [], suggestedTests: [] }));
    const out = await analyzePageSmart(BACKEND, auth, { pageModel, environment: 'staging' });

    expect(call(1).url).toBe(`${BACKEND}/api/page/analyze`);
    expect(bodyOf(1).environment).toBe('staging'); // kept on the legacy call
    expect(out.summary).toBe('legacy');
  });

  it('re-throws a non-fallback error (500)', async () => {
    fetchMock.mockResolvedValueOnce(res(500, { error: 'boom' }));
    await expect(analyzePageSmart(BACKEND, auth, { pageModel })).rejects.toThrow('boom');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-throws a 403 (role denied) without falling back', async () => {
    fetchMock.mockResolvedValueOnce(res(403, { error: 'forbidden', code: 'forbidden' }));
    await expect(analyzePageSmart(BACKEND, auth, { pageModel })).rejects.toThrow('forbidden');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the legacy endpoint directly when signed out', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { summary: 'x', risks: [], suggestedTests: [] }));
    await analyzePageSmart(BACKEND, EMPTY_AUTH, { pageModel });
    expect(call().url).toBe(`${BACKEND}/api/page/analyze`);
  });
});

describe('generateTestCasesSmart', () => {
  it('parses the unwrapped artifact shape from the gateway', async () => {
    fetchMock.mockResolvedValueOnce(
      res(200, { artifactId: 'a1', type: 'test_cases', format: 'markdown', content: '# cases' }),
    );
    const out = await generateTestCasesSmart(BACKEND, auth, { pageModel });
    expect(call().url).toBe(`${BACKEND}/api/workspaces/ws1/ai/tasks/generate-test-cases`);
    expect(out).toEqual({ artifactId: 'a1', content: '# cases', format: 'markdown' });
  });

  it('falls back to legacy with manual_markdown format on 401', async () => {
    fetchMock
      .mockResolvedValueOnce(res(401, { error: 'unauth' }))
      .mockResolvedValueOnce(res(200, { artifactId: 'l', content: 'x', format: 'markdown' }));
    await generateTestCasesSmart(BACKEND, auth, { pageModel, focus: 'login' });
    expect(call(1).url).toBe(`${BACKEND}/api/generate/test-cases`);
    expect(bodyOf(1).format).toBe('manual_markdown');
    expect(bodyOf(1).focus).toBe('login');
  });
});

describe('generatePlaywrightSmart', () => {
  it('passes the gateway response through (filename + selectorWarnings)', async () => {
    fetchMock.mockResolvedValueOnce(
      res(200, {
        artifactId: 'p1',
        type: 'playwright_test',
        format: 'typescript',
        filename: 'test.spec.ts',
        content: 'code',
        selectorWarnings: [{ eventId: 'e', message: 'fragile' }],
      }),
    );
    const out = await generatePlaywrightSmart(BACKEND, auth, { session, enrich: true });
    expect(call().url).toBe(`${BACKEND}/api/workspaces/ws1/ai/tasks/enrich-playwright`);
    expect(bodyOf().enrich).toBe(true);
    expect(out.filename).toBe('test.spec.ts');
    expect(out.selectorWarnings).toHaveLength(1);
  });
});

describe('generateBugReportSmart', () => {
  it('sends project/env context and maps the gateway bug-report shape', async () => {
    fetchMock.mockResolvedValueOnce(
      res(200, {
        taskRunId: 'run1',
        bugReport: { content: '# bug', format: 'markdown' },
        usage: { inputTokens: 1, outputTokens: 2 },
      }),
    );
    const out = await generateBugReportSmart(BACKEND, auth, { session, pageModel, userNote: 'n' });
    expect(call().url).toBe(`${BACKEND}/api/workspaces/ws1/ai/tasks/generate-bug-report`);
    expect(bodyOf().projectId).toBe('proj1');
    expect(out).toEqual({ artifactId: 'run1', content: '# bug', format: 'markdown' });
  });

  it('omits project/env keys when the context is empty', async () => {
    const noCtx: AuthState = { ...EMPTY_AUTH, token: 't', currentWorkspaceId: 'ws1' };
    fetchMock.mockResolvedValueOnce(
      res(200, { taskRunId: 'r', bugReport: { content: 'c', format: 'markdown' }, usage: {} }),
    );
    await generateBugReportSmart(BACKEND, noCtx, { session, pageModel, userNote: '' });
    const body = bodyOf();
    expect(body).not.toHaveProperty('projectId');
    expect(body).not.toHaveProperty('environmentId');
  });
});

describe('project / environment / resolve clients', () => {
  it('lists projects with a bearer token', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { projects: [] }));
    await listProjects(BACKEND, 'tok', 'ws1');
    expect(call().url).toBe(`${BACKEND}/api/workspaces/ws1/projects`);
    expect((call().init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('lists environments under a project', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { environments: [] }));
    await listEnvironments(BACKEND, 'tok', 'ws1', 'proj1');
    expect(call().url).toBe(`${BACKEND}/api/workspaces/ws1/projects/proj1/environments`);
  });

  it('encodes the url query for resolve', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { match: null }));
    await resolveUrl(BACKEND, 'tok', 'ws1', 'https://app.example.com/path?a=1');
    expect(call().url).toBe(
      `${BACKEND}/api/workspaces/ws1/resolve?url=${encodeURIComponent('https://app.example.com/path?a=1')}`,
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendChatMessage, type ChatMessage } from './backend.js';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];

describe('sendChatMessage', () => {
  it('POSTs the message history to /api/chat and returns the reply', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: 'hi back' }),
      text: async () => '',
    } as unknown as Response);

    const res = await sendChatMessage('http://localhost:8787', messages);
    expect(res).toEqual({ content: 'hi back' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:8787/api/chat');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ messages });
  });

  it('trims a trailing slash from the backend URL', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: 'x' }),
      text: async () => '',
    } as unknown as Response);

    await sendChatMessage('http://localhost:8787/', messages);
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:8787/api/chat');
  });

  it('forwards an AbortSignal', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: 'x' }),
      text: async () => '',
    } as unknown as Response);

    const controller = new AbortController();
    await sendChatMessage('http://localhost:8787', messages, controller.signal);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal).toBe(controller.signal);
  });

  it('throws with the status and body on a non-OK response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({}),
      text: async () => 'provider down',
    } as unknown as Response);

    await expect(sendChatMessage('http://localhost:8787', messages)).rejects.toThrow(
      /Backend 502: provider down/,
    );
  });
});
