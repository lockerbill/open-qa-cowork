import { describe, it, expect } from 'vitest';
import type { DestinationStream } from 'pino';
import { createLogger, type LogLevel } from '../logging/logger.js';
import { LoggingProvider } from './logging-provider.js';
import { LLMError, type CompleteOptions, type LLMProvider } from './types.js';

class StubProvider implements LLMProvider {
  readonly name = 'stub';
  constructor(private readonly behavior: (opts: CompleteOptions) => Promise<string>) {}
  complete(opts: CompleteOptions): Promise<string> {
    return this.behavior(opts);
  }
}

function wrap(level: LogLevel, behavior: (opts: CompleteOptions) => Promise<string>) {
  const lines: Record<string, unknown>[] = [];
  const stream: DestinationStream = { write: (msg) => void lines.push(JSON.parse(msg)) };
  const logger = createLogger(level, stream);
  const provider = new LoggingProvider(new StubProvider(behavior), logger, 'test-model');
  return { lines, provider };
}

const opts: CompleteOptions = { system: 'sys', user: 'hello', maxTokens: 1024 };

describe('LoggingProvider', () => {
  it('delegates name to the wrapped provider', () => {
    const { provider } = wrap('info', async () => 'x');
    expect(provider.name).toBe('stub');
  });

  it('logs request and response metadata at info', async () => {
    const { lines, provider } = wrap('info', async () => 'the answer');
    await provider.complete(opts);

    const request = lines.find((l) => l.event === 'llm.request');
    expect(request).toMatchObject({
      provider: 'stub',
      model: 'test-model',
      maxTokens: 1024,
      systemChars: 3,
      userChars: 5,
    });

    const response = lines.find((l) => l.event === 'llm.response');
    expect(response).toMatchObject({ ok: true, responseChars: 10 });
    expect(typeof response?.latencyMs).toBe('number');
    expect(response?.latencyMs as number).toBeGreaterThanOrEqual(0);
  });

  it('logs prompt and response bodies only at debug', async () => {
    const { lines, provider } = wrap('debug', async () => 'the answer');
    await provider.complete(opts);

    const requestBody = lines.find((l) => l.event === 'llm.request.body');
    expect(requestBody).toMatchObject({ system: 'sys', user: 'hello' });
    expect(lines.find((l) => l.event === 'llm.response.body')).toMatchObject({
      response: 'the answer',
    });
  });

  it('omits bodies at info', async () => {
    const { lines, provider } = wrap('info', async () => 'the answer');
    await provider.complete(opts);

    expect(lines.some((l) => l.event === 'llm.request.body')).toBe(false);
    expect(lines.some((l) => l.event === 'llm.response.body')).toBe(false);
    for (const line of lines) {
      expect(line).not.toHaveProperty('system');
      expect(line).not.toHaveProperty('user');
      expect(line).not.toHaveProperty('response');
    }
  });

  it('logs failures with the LLMError status and still rejects', async () => {
    const { lines, provider } = wrap('info', async () => {
      throw new LLMError('boom', 503);
    });

    await expect(provider.complete(opts)).rejects.toBeInstanceOf(LLMError);
    const response = lines.find((l) => l.event === 'llm.response');
    expect(response).toMatchObject({ ok: false, status: 503, err: 'boom' });
  });

  it('never emits api keys or auth headers', async () => {
    const { lines, provider } = wrap('debug', async () => 'x');
    await provider.complete(opts);
    const serialized = JSON.stringify(lines).toLowerCase();
    expect(serialized).not.toContain('apikey');
    expect(serialized).not.toContain('authorization');
  });
});
