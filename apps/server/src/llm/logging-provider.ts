import type { Logger } from '../logging/logger.js';
import {
  LLMError,
  type ChatOptions,
  type ChatToolsOptions,
  type CompleteOptions,
  type LLMProvider,
  type ToolCallResult,
} from './types.js';

/**
 * Wraps an LLMProvider to trace each call. Logs request/response metadata at
 * `info` and the full (already-redacted) prompt/response bodies at `debug`.
 *
 * The decorator only ever sees `CompleteOptions` and the returned string — API
 * keys and headers stay private inside the wrapped provider, so they can never
 * be logged here.
 */
export class LoggingProvider implements LLMProvider {
  constructor(
    private readonly inner: LLMProvider,
    private readonly logger: Logger,
    private readonly model: string,
  ) {}

  get name(): string {
    return this.inner.name;
  }

  async complete(opts: CompleteOptions): Promise<string> {
    const base = { provider: this.inner.name, model: this.model };

    this.logger.info(
      {
        event: 'llm.request',
        ...base,
        maxTokens: opts.maxTokens ?? null,
        systemChars: opts.system.length,
        userChars: opts.user.length,
      },
      'llm request',
    );
    this.logger.debug(
      { event: 'llm.request.body', ...base, system: opts.system, user: opts.user },
      'llm request body',
    );

    return this.trace(base, () => this.inner.complete(opts));
  }

  async chat(opts: ChatOptions): Promise<string> {
    const base = { provider: this.inner.name, model: this.model };
    const totalChars = opts.messages.reduce((n, m) => n + m.content.length, 0);

    this.logger.info(
      {
        event: 'llm.request',
        ...base,
        maxTokens: opts.maxTokens ?? null,
        messageCount: opts.messages.length,
        totalChars,
      },
      'llm chat request',
    );
    this.logger.debug(
      { event: 'llm.request.body', ...base, messages: opts.messages },
      'llm chat request body',
    );

    return this.trace(base, () => this.inner.chat(opts));
  }

  /**
   * Tool-calling passthrough (auto-test-mode-spec §8.3). Info logs carry
   * metadata only (counts, tool names — never message or argument payloads);
   * full bodies stay at debug, matching complete/chat.
   */
  async chatWithTools(opts: ChatToolsOptions): Promise<ToolCallResult> {
    const inner = this.inner.chatWithTools?.bind(this.inner);
    if (!inner) {
      throw new LLMError(`${this.inner.name} does not support tool calling`, 502);
    }
    const base = { provider: this.inner.name, model: this.model };
    const totalChars = opts.messages.reduce((n, m) => n + m.content.length, 0);

    this.logger.info(
      {
        event: 'llm.request',
        ...base,
        maxTokens: opts.maxTokens ?? null,
        messageCount: opts.messages.length,
        totalChars,
        toolCount: opts.tools.length,
      },
      'llm tools request',
    );
    this.logger.debug(
      { event: 'llm.request.body', ...base, messages: opts.messages, tools: opts.tools },
      'llm tools request body',
    );

    const start = performance.now();
    try {
      const result = await inner(opts);
      this.logger.info(
        {
          event: 'llm.response',
          ...base,
          ok: true,
          latencyMs: Math.round(performance.now() - start),
          toolCallCount: result.toolCalls.length,
          toolNames: result.toolCalls.map((c) => c.name),
          textChars: result.text?.length ?? 0,
        },
        'llm tools response',
      );
      this.logger.debug({ event: 'llm.response.body', ...base, result }, 'llm tools response body');
      return result;
    } catch (err) {
      this.logFailure(base, start, err);
      throw err;
    }
  }

  /** Time an inner LLM call and log its response/error metadata. */
  private async trace(
    base: { provider: string; model: string },
    call: () => Promise<string>,
  ): Promise<string> {
    const start = performance.now();
    try {
      const response = await call();
      this.logger.info(
        {
          event: 'llm.response',
          ...base,
          ok: true,
          latencyMs: Math.round(performance.now() - start),
          responseChars: response.length,
        },
        'llm response',
      );
      this.logger.debug(
        { event: 'llm.response.body', ...base, response },
        'llm response body',
      );
      return response;
    } catch (err) {
      this.logFailure(base, start, err);
      throw err;
    }
  }

  private logFailure(
    base: { provider: string; model: string },
    start: number,
    err: unknown,
  ): void {
    this.logger.info(
      {
        event: 'llm.response',
        ...base,
        ok: false,
        status: err instanceof LLMError ? err.status : undefined,
        latencyMs: Math.round(performance.now() - start),
        err: err instanceof Error ? err.message : String(err),
      },
      'llm response failed',
    );
  }
}
