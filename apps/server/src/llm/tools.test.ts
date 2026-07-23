/**
 * Task 16.4 (gateway layer): tool-calling adaptation for OpenAI-compatible and
 * Anthropic providers, timeout classification (502 provider_error vs 504
 * provider_timeout), and LoggingProvider metadata-only tracing for tool calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DestinationStream } from 'pino';
import { createLogger } from '../logging/logger.js';
import { AnthropicProvider } from './anthropic.js';
import { LoggingProvider } from './logging-provider.js';
import {
  openAICompatibleChatWithTools,
  type OpenAICompatParams,
} from './openai-compatible.js';
import {
  LLMError,
  type ChatToolsOptions,
  type LLMProvider,
  type ToolCallResult,
} from './types.js';

const PARAMS: OpenAICompatParams = {
  baseUrl: 'https://api.example/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  label: 'Test LLM',
};

const TOOLS: ChatToolsOptions = {
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'decide' },
  ],
  tools: [
    {
      name: 'click',
      description: 'Click the element at [index].',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
  ],
};

function mockJsonResponse(body: unknown) {
  const fn = vi.fn(async () => ({ ok: true, json: async () => body }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** A fetch that never resolves but honors its abort signal (real timeout shape). */
function mockHangingFetch() {
  const fn = vi.fn(
    (_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openAICompatibleChatWithTools', () => {
  it('registers the tools with tool_choice required and returns every call in order', async () => {
    const fetchMock = mockJsonResponse({
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: 'click', arguments: '{"index":3,"intent":"open"}' } },
              { function: { name: 'scroll', arguments: '{"direction":"down"}' } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const { result, usage } = await openAICompatibleChatWithTools(PARAMS, TOOLS);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.tool_choice).toBe('required');
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'click',
          description: 'Click the element at [index].',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
    ]);

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]).toMatchObject({ name: 'click', input: { index: 3, intent: 'open' } });
    expect(result.toolCalls[1]).toMatchObject({ name: 'scroll', input: { direction: 'down' } });
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('keeps raw arguments when the provider emits malformed JSON', async () => {
    mockJsonResponse({
      choices: [
        { message: { tool_calls: [{ function: { name: 'click', arguments: '{"index": 3,' } }] } },
      ],
    });
    const { result } = await openAICompatibleChatWithTools(PARAMS, TOOLS);
    expect(result.toolCalls[0]).toEqual({
      name: 'click',
      input: null,
      rawArguments: '{"index": 3,',
    });
  });

  it('classifies an abort as 504 provider_timeout', async () => {
    mockHangingFetch();
    const promise = openAICompatibleChatWithTools(PARAMS, { ...TOOLS, timeoutMs: 5 });
    await expect(promise).rejects.toMatchObject({ name: 'LLMError', status: 504 });
  });

  it('classifies a provider HTTP failure as 502 provider_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' })),
    );
    const promise = openAICompatibleChatWithTools(PARAMS, TOOLS);
    await expect(promise).rejects.toMatchObject({ name: 'LLMError', status: 502 });
  });
});

describe('AnthropicProvider.chatWithTools', () => {
  it('maps tools to the Anthropic format and parses tool_use blocks', async () => {
    const fetchMock = mockJsonResponse({
      content: [
        { type: 'text', text: 'I will click it.' },
        { type: 'tool_use', name: 'click', input: { index: 1, intent: 'open' } },
      ],
    });

    const provider = new AnthropicProvider('key', 'claude-test');
    const result = await provider.chatWithTools(TOOLS);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.tool_choice).toEqual({ type: 'any' });
    expect(body.tools).toEqual([
      {
        name: 'click',
        description: 'Click the element at [index].',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
    ]);
    expect(body.system).toBe('sys');

    expect(result.toolCalls).toEqual([{ name: 'click', input: { index: 1, intent: 'open' } }]);
    expect(result.text).toBe('I will click it.');
  });

  it('classifies an abort as 504 provider_timeout', async () => {
    mockHangingFetch();
    const provider = new AnthropicProvider('key', 'claude-test');
    await expect(provider.chatWithTools({ ...TOOLS, timeoutMs: 5 })).rejects.toMatchObject({
      name: 'LLMError',
      status: 504,
    });
  });
});

describe('LoggingProvider.chatWithTools', () => {
  function wrap(level: 'info' | 'debug', inner: LLMProvider) {
    const lines: Record<string, unknown>[] = [];
    const stream: DestinationStream = { write: (msg) => void lines.push(JSON.parse(msg)) };
    return { lines, provider: new LoggingProvider(inner, createLogger(level, stream), 'm') };
  }

  const innerWithTools: LLMProvider = {
    name: 'stub',
    complete: async () => 'x',
    chat: async () => 'x',
    chatWithTools: async (): Promise<ToolCallResult> => ({
      toolCalls: [{ name: 'click', input: { index: 3, intent: 'secret-intent' } }],
      text: 'secret-text',
    }),
  };

  it('logs metadata only at info — payloads never appear', async () => {
    const { lines, provider } = wrap('info', innerWithTools);
    await provider.chatWithTools!(TOOLS);

    const request = lines.find((l) => l.event === 'llm.request');
    expect(request).toMatchObject({ toolCount: 1, messageCount: 2, totalChars: 9 });
    const response = lines.find((l) => l.event === 'llm.response');
    expect(response).toMatchObject({ ok: true, toolCallCount: 1, toolNames: ['click'] });

    const all = JSON.stringify(lines);
    expect(all).not.toContain('secret-intent');
    expect(all).not.toContain('secret-text');
    expect(all).not.toContain('decide'); // the user message content
  });

  it('logs full bodies at debug', async () => {
    const { lines, provider } = wrap('debug', innerWithTools);
    await provider.chatWithTools!(TOOLS);
    expect(JSON.stringify(lines)).toContain('secret-intent');
  });

  it('rejects when the wrapped provider lacks the capability', async () => {
    const { provider } = wrap('info', { name: 'plain', complete: async () => 'x', chat: async () => 'x' });
    await expect(provider.chatWithTools!(TOOLS)).rejects.toBeInstanceOf(LLMError);
  });
});
