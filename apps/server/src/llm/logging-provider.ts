import type { Logger } from '../logging/logger.js';
import { LLMError, type CompleteOptions, type LLMProvider } from './types.js';

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

    const start = performance.now();
    try {
      const response = await this.inner.complete(opts);
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
      throw err;
    }
  }
}
