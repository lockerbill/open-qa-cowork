import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LocalProvider } from './local.js';
import { LLMError } from './types.js';

const ok = (content: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  }) as unknown as Response;

const cfg = { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', apiKey: '' };
const opts = { system: 'sys', user: 'hello' };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LocalProvider', () => {
  it('posts to <baseUrl>/chat/completions with model and messages', async () => {
    fetchMock.mockResolvedValue(ok('hi there'));
    const provider = new LocalProvider(cfg);
    const text = await provider.complete(opts);

    expect(text).toBe('hi there');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('llama3.1');
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('omits the authorization header when no apiKey is set', async () => {
    fetchMock.mockResolvedValue(ok('x'));
    await new LocalProvider(cfg).complete(opts);
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it('sends a Bearer token when apiKey is set', async () => {
    fetchMock.mockResolvedValue(ok('x'));
    await new LocalProvider({ ...cfg, apiKey: 'secret' }).complete(opts);
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret');
  });

  it('throws 503 when baseUrl is missing, without calling fetch', async () => {
    const provider = new LocalProvider({ ...cfg, baseUrl: '' });
    await expect(provider.complete(opts)).rejects.toMatchObject({
      name: 'LLMError',
      status: 503,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws 503 when model is missing, without calling fetch', async () => {
    const provider = new LocalProvider({ ...cfg, model: '' });
    await expect(provider.complete(opts)).rejects.toBeInstanceOf(LLMError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a non-OK response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom',
      json: async () => ({}),
    } as unknown as Response);
    await expect(new LocalProvider(cfg).complete(opts)).rejects.toThrow(/Local LLM API 500/);
  });

  it('throws when the response has no content', async () => {
    fetchMock.mockResolvedValue(ok(''));
    await expect(new LocalProvider(cfg).complete(opts)).rejects.toThrow(/no content/);
  });
});
