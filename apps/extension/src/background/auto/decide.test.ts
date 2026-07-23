/**
 * Decider-client unit suite: URL/auth shape for the stub-override and
 * workspace paths, the per-call AbortSignal timeout (a hung provider must
 * surface as a transport error, never wedge the run loop), and the 422 →
 * DeciderValidationError contract the correction turns rely on (§8.5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StepRequest } from '@qa-copilot/shared/auto';
import { decide, DECIDE_TIMEOUT_MS } from './decide.js';
import { DeciderValidationError } from './run-controller.js';

const request = {
  goal: 'explore',
  mode: 'autonomous',
  history: [],
  observation: { url: 'http://localhost:5555/x', epoch: 1 },
  stepsRemaining: 5,
  placeholders: [],
} as unknown as StepRequest;

const FINISH = { action: { type: 'finish', outcome: 'pass', reason: 'done' } };

/** Build a fetch Response stub. */
function res(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(text) : body),
  } as unknown as Response;
}

const fetchMock = vi.fn();
let store: Record<string, unknown> = {};

beforeEach(() => {
  store = {};
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: store[key] }),
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

/** The (url, init) of the Nth fetch call. */
function call(n = 0): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[n]!;
  return { url, init };
}

describe('decide — stub-override path', () => {
  it('POSTs {base}/auto/step with the request body and an abort signal', async () => {
    fetchMock.mockResolvedValueOnce(res(200, FINISH));
    const out = await decide('http://127.0.0.1:5557/', request);

    expect(call().url).toBe('http://127.0.0.1:5557/auto/step');
    expect(call().init.method).toBe('POST');
    expect(JSON.parse(call().init.body as string)).toEqual(JSON.parse(JSON.stringify(request)));
    expect(call().init.signal).toBeInstanceOf(AbortSignal);
    expect(out).toEqual(FINISH);
  });

  it('translates an abort into a labeled transport error (not a DeciderValidationError)', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'));
    const failure = decide('http://127.0.0.1:5557', request);
    await expect(failure).rejects.toThrow(`timed out after ${DECIDE_TIMEOUT_MS}ms`);
    await expect(failure).rejects.not.toBeInstanceOf(DeciderValidationError);
  });

  it('throws DeciderValidationError with the detail on a 422', async () => {
    fetchMock.mockResolvedValueOnce(res(422, { detail: "type 'click': index: Required" }));
    await expect(decide('http://127.0.0.1:5557', request)).rejects.toThrow(
      new DeciderValidationError("type 'click': index: Required"),
    );
  });

  it('throws a plain HTTP error on a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce(res(500, { error: 'boom' }));
    await expect(decide('http://127.0.0.1:5557', request)).rejects.toThrow('decider HTTP 500');
  });
});

describe('decide — workspace path', () => {
  it('targets the workspace endpoint with bearer auth, context ids, and an abort signal', async () => {
    store['settings'] = { backendUrl: 'http://localhost:8787/' };
    store['auth'] = { token: 'tok', currentWorkspaceId: 'ws1', currentProjectId: 'proj1' };
    fetchMock.mockResolvedValueOnce(res(200, FINISH));
    const out = await decide('', request);

    expect(call().url).toBe('http://localhost:8787/api/workspaces/ws1/auto/step');
    expect((call().init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(call().init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(call().init.body as string);
    expect(body.projectId).toBe('proj1');
    expect(body).not.toHaveProperty('environmentId'); // unset context stays absent
    expect(out).toEqual(FINISH);
  });

  it('rejects without a signed-in workspace', async () => {
    await expect(decide('', request)).rejects.toThrow(/signed-in workspace/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
