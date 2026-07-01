import { openAICompatibleChat, openAICompatibleComplete } from './openai-compatible.js';
import { LLMError, type ChatOptions, type CompleteOptions, type LLMProvider } from './types.js';

export interface LocalConfig {
  /** OpenAI-compatible base URL including /v1, e.g. http://localhost:11434/v1 */
  baseUrl: string;
  model: string;
  /** Usually blank; set only if the local server requires a bearer token. */
  apiKey: string;
  /**
   * Whether to let reasoning models (Qwen3, etc.) emit thinking tokens. Off by
   * default: thinking burns the output budget and can leave `content` empty,
   * which surfaced as a 502 "Local LLM returned no content".
   */
  enableThinking: boolean;
  /** Per-call output token cap; overrides the OpenAI-compatible default of 2048. */
  maxTokens?: number;
  /** Abort the request after this many ms (local inference can be slow). */
  timeoutMs?: number;
}

/** Local model served via any OpenAI-compatible endpoint (spec §12.2). */
export class LocalProvider implements LLMProvider {
  readonly name = 'local';

  constructor(private readonly cfg: LocalConfig) {}

  /** Build the shared OpenAI-compatible params, applying the thinking toggle. */
  private params() {
    if (!this.cfg.baseUrl) throw new LLMError('LOCAL_BASE_URL is not configured', 503);
    if (!this.cfg.model) throw new LLMError('LOCAL_MODEL is not configured', 503);
    // vLLM/SGLang read chat_template_kwargs to toggle a reasoning model's
    // thinking. Only sent when thinking is disabled; harmless on templates
    // that ignore it. Omitted entirely when thinking is enabled.
    const extraBody = this.cfg.enableThinking
      ? undefined
      : { chat_template_kwargs: { enable_thinking: false } };
    return {
      baseUrl: this.cfg.baseUrl,
      apiKey: this.cfg.apiKey,
      model: this.cfg.model,
      label: 'Local LLM',
      requireApiKey: false,
      extraBody,
      timeoutMs: this.cfg.timeoutMs,
    };
  }

  // LOCAL_MAX_TOKENS acts as a floor: it can only raise a route's request,
  // never lower it. Routes pass small caps tuned for fast cloud models; local
  // models are wordier and may need more headroom to finish (avoids truncated
  // output / finish_reason=length). Unset leaves the route default untouched.
  private floorTokens(maxTokens?: number): number | undefined {
    return Math.max(maxTokens ?? 0, this.cfg.maxTokens ?? 0) || undefined;
  }

  async complete(opts: CompleteOptions): Promise<string> {
    return openAICompatibleComplete(this.params(), {
      ...opts,
      maxTokens: this.floorTokens(opts.maxTokens),
    });
  }

  async chat(opts: ChatOptions): Promise<string> {
    return openAICompatibleChat(this.params(), {
      ...opts,
      maxTokens: this.floorTokens(opts.maxTokens),
    });
  }
}
