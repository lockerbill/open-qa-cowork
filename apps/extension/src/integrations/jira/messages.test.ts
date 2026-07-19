import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JiraConfig, TestSession } from '@qa-copilot/shared';
import {
  buildAttachments,
  dataUrlToBlob,
  handleJiraMessage,
  validateJiraConfig,
  type JiraCreateIssueRequest,
  type JiraResponse,
} from './messages.js';
import { requestJiraOrigin } from './auth.js';

const SITE = 'https://acme.atlassian.net';

const config: JiraConfig = {
  siteUrl: SITE,
  email: 'qa@acme.io',
  apiToken: 'tok-123',
  projectKey: 'QA',
  issueTypeId: '10004',
  priorityMap: { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' },
  verified: true,
};

function session(overrides: Partial<TestSession> = {}): TestSession {
  return {
    id: 's1',
    startedAt: '2026-07-19T00:00:00.000Z',
    status: 'stopped',
    events: [],
    evidence: [],
    consoleErrors: [],
    networkFailures: [],
    ...overrides,
  } as TestSession;
}

/** 1x1 transparent PNG. */
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let store: Record<string, unknown> = {};
const permissionsContains = vi.fn();
const permissionsRequest = vi.fn();
const fetchMock = vi.fn();

function res(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    headers: { get: () => null },
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(text) : body),
  } as unknown as Response;
}

beforeEach(() => {
  store = {};
  permissionsContains.mockReset().mockResolvedValue(true);
  permissionsRequest.mockReset().mockResolvedValue(true);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: store[key] }),
        set: (items: Record<string, unknown>) => {
          Object.assign(store, items);
          return Promise.resolve();
        },
      },
    },
    permissions: { contains: permissionsContains, request: permissionsRequest },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('validateJiraConfig', () => {
  it('accepts a complete config', () => {
    expect(validateJiraConfig(config)).toBeNull();
  });

  it('names the first missing or invalid field', () => {
    expect(validateJiraConfig(null)).toMatch(/missing/i);
    expect(validateJiraConfig({ ...config, siteUrl: '' })).toMatch(/Site URL is required/);
    expect(validateJiraConfig({ ...config, siteUrl: 'not a url' })).toMatch(/not a valid/);
    expect(validateJiraConfig({ ...config, email: '' })).toMatch(/email/i);
    expect(validateJiraConfig({ ...config, apiToken: '' })).toMatch(/token/i);
  });
});

describe('dataUrlToBlob', () => {
  it('decodes a base64 data URL to a typed blob', async () => {
    const blob = dataUrlToBlob(PNG_DATA_URL);
    expect(blob?.type).toBe('image/png');
    expect(blob!.size).toBeGreaterThan(0);
  });

  it('decodes a plain (non-base64) data URL, percent-decoding the payload', () => {
    // jsdom's Blob has no .text(), so assert on the decoded byte length:
    // "hello%20world" -> "hello world" is 11 bytes, not 13.
    const blob = dataUrlToBlob('data:text/plain,hello%20world');
    expect(blob?.type).toBe('text/plain');
    expect(blob?.size).toBe(11);
  });

  it('returns null for input that is not a data URL', () => {
    expect(dataUrlToBlob('https://example.com/x.png')).toBeNull();
    expect(dataUrlToBlob('')).toBeNull();
  });
});

describe('buildAttachments', () => {
  const request = (overrides: Partial<JiraCreateIssueRequest> = {}): JiraCreateIssueRequest => ({
    artifactId: 'a1',
    payload: { fields: { project: { key: 'QA' }, issuetype: { id: '1' }, summary: 's', description: { version: 1, type: 'doc', content: [] } } },
    attachSession: false,
    playwrightSpec: null,
    ...overrides,
  });

  const withShots = session({
    evidence: [
      { id: 'e1', sessionId: 's1', type: 'screenshot', dataUrl: PNG_DATA_URL, capturedAt: '' },
      { id: 'e2', sessionId: 's1', type: 'console', capturedAt: '' },
      { id: 'e3', sessionId: 's1', type: 'screenshot', dataUrl: PNG_DATA_URL, capturedAt: '' },
    ],
  } as Partial<TestSession>);

  it('takes screenshots from the session, skipping other evidence', () => {
    const files = buildAttachments(withShots, request());
    expect(files.map((f) => f.filename)).toEqual(['screenshot-1.png', 'screenshot-2.png']);
  });

  it('includes the session export only when asked', () => {
    expect(buildAttachments(withShots, request()).some((f) => f.filename.endsWith('.json'))).toBe(false);
    const withJson = buildAttachments(withShots, request({ attachSession: true }));
    expect(withJson.map((f) => f.filename)).toContain('session-s1.json');
  });

  it('includes the Playwright spec when one was generated', () => {
    const files = buildAttachments(
      withShots,
      request({ playwrightSpec: { filename: 'login.spec.ts', content: 'test()' } }),
    );
    expect(files.map((f) => f.filename)).toContain('login.spec.ts');
  });

  it('skips screenshots whose data URL cannot be decoded', () => {
    const broken = session({
      evidence: [{ id: 'e1', sessionId: 's1', type: 'screenshot', dataUrl: 'not-a-data-url', capturedAt: '' }],
    } as Partial<TestSession>);
    expect(buildAttachments(broken, request())).toHaveLength(0);
  });
});

describe('requestJiraOrigin', () => {
  it('skips the prompt when the origin is already granted', async () => {
    permissionsContains.mockResolvedValue(true);
    await expect(requestJiraOrigin(SITE)).resolves.toBe(true);
    expect(permissionsRequest).not.toHaveBeenCalled();
  });

  it('prompts for the single configured origin when not yet granted', async () => {
    permissionsContains.mockResolvedValue(false);
    permissionsRequest.mockResolvedValue(true);

    await expect(requestJiraOrigin(`${SITE}/jira/software`)).resolves.toBe(true);
    expect(permissionsRequest).toHaveBeenCalledWith({ origins: [`${SITE}/*`] });
  });

  it('refuses an unparseable site URL without prompting', async () => {
    await expect(requestJiraOrigin('nonsense')).resolves.toBe(false);
    expect(permissionsRequest).not.toHaveBeenCalled();
  });
});

describe('handleJiraMessage: config', () => {
  it('projects stored config without the API token', async () => {
    store.jiraConfig = config;
    const out = (await handleJiraMessage({ type: 'JIRA_GET_CONFIG' })) as JiraResponse<Record<string, unknown>>;

    expect(out.ok).toBe(true);
    const data = (out as { data: Record<string, unknown> }).data;
    expect(data.hasToken).toBe(true);
    expect(data.siteUrl).toBe(SITE);
    expect(JSON.stringify(data)).not.toContain('tok-123');
  });

  it('returns null when nothing is configured', async () => {
    const out = (await handleJiraMessage({ type: 'JIRA_GET_CONFIG' })) as JiraResponse<null>;
    expect(out).toMatchObject({ ok: true, data: null });
  });

  it('checks permission for the configured origin only', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { accountId: 'a', displayName: 'QA' }));
    await handleJiraMessage({ type: 'JIRA_SAVE_CONFIG', config });

    expect(permissionsContains).toHaveBeenCalledWith({ origins: [`${SITE}/*`] });
  });

  it('never calls permissions.request from the worker', async () => {
    // It throws "must be called during a user gesture" there; the options page
    // owns the request. Regression guard for a bug the E2E caught.
    fetchMock.mockResolvedValueOnce(res(200, { accountId: 'a', displayName: 'QA' }));
    await handleJiraMessage({ type: 'JIRA_SAVE_CONFIG', config });

    expect(permissionsRequest).not.toHaveBeenCalled();
  });

  it('does not save when the origin permission is missing', async () => {
    permissionsContains.mockResolvedValue(false);
    const out = await handleJiraMessage({ type: 'JIRA_SAVE_CONFIG', config });

    expect(out.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.jiraConfig).toBeUndefined();
  });

  it('does not save when the credentials are rejected', async () => {
    fetchMock.mockResolvedValueOnce(res(401, ''));
    const out = await handleJiraMessage({ type: 'JIRA_SAVE_CONFIG', config });

    expect(out).toMatchObject({ ok: false, code: 'unauthorized' });
    expect(store.jiraConfig).toBeUndefined();
  });

  it('saves as verified once the connection test passes', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { accountId: 'a', displayName: 'QA Bot' }));
    const out = await handleJiraMessage({ type: 'JIRA_SAVE_CONFIG', config });

    expect(out.ok).toBe(true);
    expect(store.jiraConfig).toMatchObject({ verified: true, apiToken: 'tok-123' });
  });

  it('tests a connection without persisting it', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { accountId: 'a', displayName: 'QA Bot' }));
    const out = await handleJiraMessage({ type: 'JIRA_TEST_CONNECTION', config });

    expect(out.ok).toBe(true);
    expect(store.jiraConfig).toBeUndefined();
  });

  it('keeps the stored token when the incoming one is blank', async () => {
    store.jiraConfig = config;
    fetchMock.mockResolvedValueOnce(res(200, { accountId: 'a', displayName: 'QA Bot' }));
    await handleJiraMessage({ type: 'JIRA_SAVE_CONFIG', config: { ...config, apiToken: '' } });

    expect(store.jiraConfig).toMatchObject({ apiToken: 'tok-123' });
  });
});

describe('handleJiraMessage: create issue', () => {
  const request: JiraCreateIssueRequest = {
    artifactId: 'artifact-1',
    payload: {
      fields: {
        project: { key: 'QA' },
        issuetype: { id: '10004' },
        summary: 'Release date does not default',
        description: { version: 1, type: 'doc', content: [] },
      },
    },
    attachSession: true,
    playwrightSpec: null,
  };

  it('refuses when no Jira connection is stored', async () => {
    const out = await handleJiraMessage({ type: 'JIRA_CREATE_ISSUE', request });
    expect(out).toMatchObject({ ok: false, code: 'not_configured' });
  });

  it('rejects a payload with no summary before calling Jira', async () => {
    store.jiraConfig = config;
    const out = await handleJiraMessage({
      type: 'JIRA_CREATE_ISSUE',
      request: { ...request, payload: { fields: { ...request.payload.fields, summary: '' } } },
    });

    expect(out).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates the issue, persists the link, and uploads attachments', async () => {
    store.jiraConfig = config;
    store.session = session({
      evidence: [{ id: 'e1', sessionId: 's1', type: 'screenshot', dataUrl: PNG_DATA_URL, capturedAt: '' }],
    } as Partial<TestSession>);
    fetchMock
      .mockResolvedValueOnce(res(201, { id: '1', key: 'QA-7' }))
      .mockResolvedValue(res(200, []));

    const out = (await handleJiraMessage({ type: 'JIRA_CREATE_ISSUE', request })) as JiraResponse<{
      link: { issueKey: string; url: string };
      attachments: { ok: boolean }[];
    }>;

    expect(out.ok).toBe(true);
    const data = (out as { data: { link: { issueKey: string; url: string }; attachments: { ok: boolean }[] } }).data;
    expect(data.link.issueKey).toBe('QA-7');
    expect(data.link.url).toBe(`${SITE}/browse/QA-7`);
    expect(data.attachments).toHaveLength(2); // screenshot + session.json
    expect(store.jiraLinks).toMatchObject({ 'artifact-1': { issueKey: 'QA-7', type: 'jira' } });
  });

  it('still returns the link when attachments fail', async () => {
    store.jiraConfig = config;
    store.session = session();
    fetchMock
      .mockResolvedValueOnce(res(201, { id: '1', key: 'QA-8' }))
      .mockResolvedValue(res(403, { errorMessages: ['No attachment permission'] }));

    const out = (await handleJiraMessage({ type: 'JIRA_CREATE_ISSUE', request })) as JiraResponse<{
      link: { issueKey: string };
      attachments: { ok: boolean; error?: string }[];
    }>;

    expect(out.ok).toBe(true);
    const data = (out as { data: { link: { issueKey: string }; attachments: { ok: boolean; error?: string }[] } }).data;
    expect(data.link.issueKey).toBe('QA-8');
    expect(data.attachments.every((a) => !a.ok)).toBe(true);
    expect(store.jiraLinks).toMatchObject({ 'artifact-1': { issueKey: 'QA-8' } });
  });

  it('surfaces a field validation error from Jira', async () => {
    store.jiraConfig = config;
    store.session = session();
    fetchMock.mockResolvedValueOnce(res(400, { errors: { customfield_1: 'Team is required' } }));

    const out = await handleJiraMessage({ type: 'JIRA_CREATE_ISSUE', request });
    expect(out).toMatchObject({ ok: false, code: 'validation' });
    expect((out as { fieldErrors: Record<string, string> }).fieldErrors.customfield_1).toBe('Team is required');
    expect(store.jiraLinks).toBeUndefined();
  });
});
