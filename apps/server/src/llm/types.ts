export interface CompleteOptions {
  system: string;
  user: string;
  maxTokens?: number;
}

/** Provider-agnostic LLM gateway (spec §12.2 — Anthropic | OpenAI | local). */
export interface LLMProvider {
  readonly name: string;
  complete(opts: CompleteOptions): Promise<string>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}
