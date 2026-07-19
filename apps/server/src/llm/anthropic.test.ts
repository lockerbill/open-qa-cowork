import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AnthropicProvider } from './anthropic.js';

const ok = (text: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text }] }),
    text: async () => '',
  }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AnthropicProvider', () => {
  it('complete() sends the system prompt as a top-level field, not a message', async () => {
    fetchMock.mockResolvedValue(ok('hi'));
    await new AnthropicProvider('sk-ant', 'claude-sonnet-4-6').complete({
      system: 'be helpful',
      user: 'hello',
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.system).toBe('be helpful');
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('chat() extracts system messages and preserves user/assistant turns', async () => {
    fetchMock.mockResolvedValue(ok('multi-turn'));
    const text = await new AnthropicProvider('sk-ant', 'claude-sonnet-4-6').chat({
      messages: [
        { role: 'system', content: 'persona' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
    });

    expect(text).toBe('multi-turn');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.system).toBe('persona');
    expect(body.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ]);
  });

  it('omits the system field when no system message is present', async () => {
    fetchMock.mockResolvedValue(ok('x'));
    await new AnthropicProvider('sk-ant', 'claude-sonnet-4-6').chat({
      messages: [{ role: 'user', content: 'hi' }],
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('system');
  });

  it('throws 503 when the API key is missing, without calling fetch', async () => {
    await expect(
      new AnthropicProvider('', 'claude-sonnet-4-6').chat({
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ name: 'LLMError', status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
