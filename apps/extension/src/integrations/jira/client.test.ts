import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BasicTokenAuth, normalizeSiteUrl } from './auth.js';
import { JiraClient, JiraError, type AttachmentInput } from './client.js';
import { markdownToAdf } from './adf.js';

const SITE = 'https://acme.atlassian.net';

/** Build a fetch Response stub, mirroring the helper in sidepanel/backend.test.ts. */
function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    headers: { get: (name: string) => headers[name] ?? null },
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(text) : body),
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function call(n = 0): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[n]!;
  return { url, init };
}

function headerOf(n: number, name: string): string | undefined {
  return (call(n).init.headers as Record<string, string> | undefined)?.[name];
}

/** Client whose retry sleep resolves immediately. */
function client(sleep = vi.fn().mockResolvedValue(undefined)): JiraClient {
  const auth = new BasicTokenAuth({ siteUrl: SITE, email: 'qa@acme.io', apiToken: 'tok-123' });
  return new JiraClient(auth, { sleep });
}

describe('normalizeSiteUrl', () => {
  it('reduces user input to a bare origin', () => {
    expect(normalizeSiteUrl('https://acme.atlassian.net/')).toBe(SITE);
    expect(normalizeSiteUrl('  https://acme.atlassian.net/jira/software  ')).toBe(SITE);
    expect(normalizeSiteUrl('acme.atlassian.net')).toBe(SITE);
    expect(normalizeSiteUrl('https://jira.acme.co.uk')).toBe('https://jira.acme.co.uk');
  });

  it('returns empty string for input it cannot parse', () => {
    expect(normalizeSiteUrl('')).toBe('');
    expect(normalizeSiteUrl('   ')).toBe('');
    expect(normalizeSiteUrl('http://')).toBe('');
    expect(normalizeSiteUrl('://')).toBe('');
  });

  it('rejects a bare hostname with no dot rather than inventing an origin', () => {
    // Regression: stripping the trailing slash first turned "http://" into
    // "http:", which was then re-prefixed into the bogus origin "https://http".
    expect(normalizeSiteUrl('acme')).toBe('');
    expect(normalizeSiteUrl('http://')).not.toBe('https://http');
  });
});

describe('BasicTokenAuth', () => {
  it('base64-encodes email:token in the Authorization header', () => {
    const auth = new BasicTokenAuth({ siteUrl: SITE, email: 'qa@acme.io', apiToken: 'tok-123' });
    expect(auth.getHeaders().Authorization).toBe(`Basic ${btoa('qa@acme.io:tok-123')}`);
    expect(auth.getBaseUrl()).toBe(SITE);
  });

  it('handles non-Latin1 characters without throwing', () => {
    const auth = new BasicTokenAuth({ siteUrl: SITE, email: 'qä@acme.io', apiToken: 'tøk' });
    expect(() => auth.getHeaders()).not.toThrow();
    expect(auth.getHeaders().Authorization).toMatch(/^Basic /);
  });
});

describe('JiraClient.myself', () => {
  it('calls /rest/api/3/myself with the auth header', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { accountId: 'a1', displayName: 'QA Bot' }));
    const user = await client().myself();

    expect(call().url).toBe(`${SITE}/rest/api/3/myself`);
    expect(headerOf(0, 'Authorization')).toMatch(/^Basic /);
    expect(user.displayName).toBe('QA Bot');
  });
});

describe('JiraClient.createIssue', () => {
  it('POSTs JSON and derives the browse URL from the site', async () => {
    fetchMock.mockResolvedValueOnce(res(201, { id: '1001', key: 'QA-7' }));
    const created = await client().createIssue({
      fields: {
        project: { key: 'QA' },
        issuetype: { id: '10004' },
        summary: 'Release date does not default',
        description: markdownToAdf('# hi'),
      },
    });

    expect(call().url).toBe(`${SITE}/rest/api/3/issue`);
    expect(call().init.method).toBe('POST');
    expect(headerOf(0, 'Content-Type')).toBe('application/json');
    expect(created.key).toBe('QA-7');
    expect(created.url).toBe(`${SITE}/browse/QA-7`);
  });
});

describe('JiraClient.getCreateMeta', () => {
  it('normalizes the field list, preserving required flags and allowed values', async () => {
    fetchMock.mockResolvedValueOnce(
      res(200, {
        fields: [
          { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } },
          {
            fieldId: 'customfield_101',
            name: 'Team',
            required: true,
            schema: { type: 'option' },
            allowedValues: [{ id: '5', value: 'Payments' }],
          },
          { fieldId: 'labels', name: 'Labels', required: false, schema: { type: 'array' } },
        ],
      }),
    );

    const fields = await client().getCreateMeta('QA', '10004');
    expect(call().url).toBe(`${SITE}/rest/api/3/issue/createmeta/QA/issuetypes/10004`);
    expect(fields.filter((f) => f.required).map((f) => f.fieldId)).toEqual(['summary', 'customfield_101']);
    expect(fields[1]?.allowedValues?.[0]?.value).toBe('Payments');
  });

  it('url-encodes a project key that needs it', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { fields: [] }));
    await client().getCreateMeta('A B', '1');
    expect(call().url).toContain('/createmeta/A%20B/issuetypes/1');
  });
});

describe('JiraClient error translation', () => {
  const cases: [number, string][] = [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [413, 'too_large'],
    [500, 'server'],
  ];

  for (const [status, code] of cases) {
    it(`maps HTTP ${status} to code "${code}"`, async () => {
      fetchMock.mockResolvedValueOnce(res(status, ''));
      await expect(client().myself()).rejects.toMatchObject({ code, status });
    });
  }

  it('surfaces per-field messages from a 400', async () => {
    fetchMock.mockResolvedValueOnce(
      res(400, {
        errorMessages: [],
        errors: { summary: 'Summary must not be empty', customfield_101: 'Team is required' },
      }),
    );

    const err = await client()
      .createIssue({
        fields: {
          project: { key: 'QA' },
          issuetype: { id: '1' },
          summary: '',
          description: markdownToAdf(''),
        },
      })
      .then(
        () => null,
        (e: unknown) => e as JiraError,
      );

    expect(err).toBeInstanceOf(JiraError);
    expect(err?.code).toBe('validation');
    expect(err?.fieldErrors.summary).toBe('Summary must not be empty');
    expect(err?.fieldErrors.customfield_101).toBe('Team is required');
  });

  it('prefers Jira’s own errorMessages over the default guidance', async () => {
    fetchMock.mockResolvedValueOnce(res(403, { errorMessages: ['Issue type is not available'] }));
    await expect(client().myself()).rejects.toThrow('Issue type is not available');
  });

  it('falls back to guidance when the body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(res(401, '<html>nope</html>'));
    await expect(client().myself()).rejects.toThrow(/API token may have expired/);
  });

  it('reports a fetch rejection as a network error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(client().myself()).rejects.toMatchObject({ code: 'network', status: 0 });
  });
});

describe('JiraClient 429 handling', () => {
  it('retries once, honouring Retry-After, then succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    fetchMock
      .mockResolvedValueOnce(res(429, '', { 'Retry-After': '2' }))
      .mockResolvedValueOnce(res(200, { accountId: 'a1', displayName: 'QA Bot' }));

    const user = await client(sleep).myself();

    expect(sleep).toHaveBeenCalledWith(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(user.displayName).toBe('QA Bot');
  });

  it('gives up after a single retry', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(res(429, '', { 'Retry-After': '1' }));

    await expect(client(sleep).myself()).rejects.toMatchObject({ code: 'rate_limited' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('caps an absurd Retry-After and defaults when the header is missing', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    fetchMock
      .mockResolvedValueOnce(res(429, '', { 'Retry-After': '99999' }))
      .mockResolvedValueOnce(res(200, {}));
    await client(sleep).myself();
    expect(sleep).toHaveBeenCalledWith(60_000);

    sleep.mockClear();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(res(429, '')).mockResolvedValueOnce(res(200, {}));
    await client(sleep).myself();
    expect(sleep).toHaveBeenCalledWith(1000);
  });
});

describe('JiraClient.addAttachments', () => {
  const file = (name: string, size = 10): AttachmentInput => ({
    filename: name,
    blob: new Blob(['x'.repeat(size)]),
  });

  it('uploads each file with the XSRF opt-out header', async () => {
    fetchMock.mockResolvedValue(res(200, []));
    const results = await client().addAttachments('QA-7', [file('shot-1.png'), file('session.json')]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(call().url).toBe(`${SITE}/rest/api/3/issue/QA-7/attachments`);
    expect(headerOf(0, 'X-Atlassian-Token')).toBe('no-check');
    expect(call().init.body).toBeInstanceOf(FormData);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('does not set Content-Type, so fetch can add the multipart boundary', async () => {
    fetchMock.mockResolvedValue(res(200, []));
    await client().addAttachments('QA-7', [file('shot-1.png')]);
    expect(headerOf(0, 'Content-Type')).toBeUndefined();
  });

  it('skips oversized files without calling Jira', async () => {
    fetchMock.mockResolvedValue(res(200, []));
    const results = await client().addAttachments('QA-7', [file('huge.png', 2048)], 1024);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toMatch(/exceeds/);
  });

  it('reports partial failure without throwing', async () => {
    fetchMock
      .mockResolvedValueOnce(res(200, []))
      .mockResolvedValueOnce(res(403, { errorMessages: ['No permission to create attachments'] }));

    const results = await client().addAttachments('QA-7', [file('ok.png'), file('denied.png')]);

    expect(results[0]).toMatchObject({ filename: 'ok.png', ok: true });
    expect(results[1]).toMatchObject({ filename: 'denied.png', ok: false });
    expect(results[1]?.error).toContain('No permission');
  });
});
