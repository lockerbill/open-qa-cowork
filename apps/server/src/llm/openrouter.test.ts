import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenRouterProvider } from './openrouter.js';
import { LLMError } from './types.js';

const ok = (content: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  }) as unknown as Response;

const opts = { system: 'sys', user: 'hello' };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenRouterProvider', () => {
  it('posts to the OpenRouter endpoint with model, messages, and Bearer auth', async () => {
    fetchMock.mockResolvedValue(ok('hi there'));
    const provider = new OpenRouterProvider('sk-or-key', 'anthropic/claude-sonnet-4-6');
    const text = await provider.complete(opts);

    expect(text).toBe('hi there');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-or-key');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('anthropic/claude-sonnet-4-6');
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('chat() passes the full message history straight through', async () => {
    fetchMock.mockResolvedValue(ok('multi-turn reply'));
    const provider = new OpenRouterProvider('sk-or-key', 'anthropic/claude-sonnet-4-6');
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'reply' },
      { role: 'user' as const, content: 'second' },
    ];
    const text = await provider.chat({ messages });

    expect(text).toBe('multi-turn reply');
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.messages).toEqual(messages);
  });

  it('throws 503 when model is missing, without calling fetch', async () => {
    const provider = new OpenRouterProvider('sk-or-key', '');
    await expect(provider.complete(opts)).rejects.toMatchObject({
      name: 'LLMError',
      status: 503,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws 503 when apiKey is missing, without calling fetch', async () => {
    const provider = new OpenRouterProvider('', 'anthropic/claude-sonnet-4-6');
    await expect(provider.complete(opts)).rejects.toMatchObject({
      name: 'LLMError',
      status: 503,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a non-OK response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom',
      json: async () => ({}),
    } as unknown as Response);
    await expect(
      new OpenRouterProvider('sk-or-key', 'anthropic/claude-sonnet-4-6').complete(opts),
    ).rejects.toThrow(/OpenRouter API 500/);
  });

  it('throws when the response has no content', async () => {
    fetchMock.mockResolvedValue(ok(''));
    await expect(
      new OpenRouterProvider('sk-or-key', 'anthropic/claude-sonnet-4-6').complete(opts),
    ).rejects.toBeInstanceOf(LLMError);
  });
});
