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

/** A function/tool the model may call (auto-test-mode-spec §8.3). */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  /** Parsed tool arguments; null when the provider sent malformed JSON. */
  input: unknown;
  /** Verbatim arguments payload, kept for recovery parsing / diagnostics. */
  rawArguments?: string;
}

export interface ChatToolsOptions {
  messages: ChatMessage[];
  tools: ToolDef[];
  maxTokens?: number;
  /** Per-call cap; the provider request aborts with LLMError 504 when exceeded. */
  timeoutMs?: number;
}

export interface ToolCallResult {
  /** Every tool call the provider returned, in order. Callers take the first. */
  toolCalls: ToolCall[];
  /** Plain text the provider returned alongside/instead of tool calls. */
  text?: string;
}

/** Provider-agnostic LLM gateway (spec §12.2 — Anthropic | OpenAI | local). */
export interface LLMProvider {
  readonly name: string;
  /** Single-turn completion (system + one user message). */
  complete(opts: CompleteOptions): Promise<string>;
  /** Multi-turn chat over a full message history. */
  chat(opts: ChatOptions): Promise<string>;
  /**
   * Opt-in tool-calling capability (auto-test-mode-spec §8.3): forces a tool
   * choice (`required`/`any`) and returns the calls. Absent on providers
   * without function-calling support — callers fall back to JSON mode.
   */
  chatWithTools?(opts: ChatToolsOptions): Promise<ToolCallResult>;
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
