export interface CompleteOptions {
  system: string;
  user: string;
  maxTokens?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  messages: ChatMessage[];
  maxTokens?: number;
}

/** Provider-agnostic LLM gateway (spec §12.2 — Anthropic | OpenAI | local). */
export interface LLMProvider {
  readonly name: string;
  /** Single-turn completion (system + one user message). */
  complete(opts: CompleteOptions): Promise<string>;
  /** Multi-turn chat over a full message history. */
  chat(opts: ChatOptions): Promise<string>;
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
