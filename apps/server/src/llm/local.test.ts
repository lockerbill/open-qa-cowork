import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LocalProvider } from './local.js';
import { LLMError } from './types.js';

const ok = (
  content: string | null,
  extra: { finish_reason?: string; reasoning_content?: string; usage?: unknown } = {},
) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          finish_reason: extra.finish_reason,
          message: { content, reasoning_content: extra.reasoning_content },
        },
      ],
      usage: extra.usage,
    }),
    text: async () => '',
  }) as unknown as Response;

const cfg = {
  baseUrl: 'http://localhost:11434/v1',
  model: 'llama3.1',
  apiKey: '',
  enableThinking: false,
};
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

  it('disables thinking by default via chat_template_kwargs', async () => {
    fetchMock.mockResolvedValue(ok('hi'));
    await new LocalProvider(cfg).complete(opts);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('omits chat_template_kwargs when thinking is enabled', async () => {
    fetchMock.mockResolvedValue(ok('hi'));
    await new LocalProvider({ ...cfg, enableThinking: true }).complete(opts);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.chat_template_kwargs).toBeUndefined();
  });

  it('passes a configured maxTokens through to the request', async () => {
    fetchMock.mockResolvedValue(ok('hi'));
    await new LocalProvider({ ...cfg, maxTokens: 4096 }).complete(opts);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.max_tokens).toBe(4096);
  });

  it('lets a configured maxTokens raise a smaller per-route cap', async () => {
    fetchMock.mockResolvedValue(ok('hi'));
    await new LocalProvider({ ...cfg, maxTokens: 4096 }).complete({ ...opts, maxTokens: 1024 });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.max_tokens).toBe(4096);
  });

  it('never lowers a larger per-route cap below the configured maxTokens', async () => {
    fetchMock.mockResolvedValue(ok('hi'));
    await new LocalProvider({ ...cfg, maxTokens: 1024 }).complete({ ...opts, maxTokens: 3072 });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.max_tokens).toBe(3072);
  });

  it('strips inline <think> blocks from the returned content', async () => {
    fetchMock.mockResolvedValue(ok('<think>reasoning here</think>\nReal answer.'));
    const text = await new LocalProvider(cfg).complete(opts);
    expect(text).toBe('Real answer.');
  });

  it('reports finish_reason and a thinking hint when content is empty', async () => {
    fetchMock.mockResolvedValue(
      ok('', { finish_reason: 'length', usage: { completion_tokens: 2048 } }),
    );
    await expect(new LocalProvider(cfg).complete(opts)).rejects.toThrow(
      /no content \(finish_reason=length, completion_tokens=2048\).*thinking/,
    );
  });

  it('throws a 504 when the request exceeds the timeout', async () => {
    fetchMock.mockImplementation((_url, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    await expect(
      new LocalProvider({ ...cfg, timeoutMs: 10 }).complete(opts),
    ).rejects.toMatchObject({ name: 'LLMError', status: 504 });
  });
});
