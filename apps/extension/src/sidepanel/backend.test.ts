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
