import { openAICompatibleChat, openAICompatibleComplete } from './openai-compatible.js';
import { LLMError, type ChatOptions, type CompleteOptions, type LLMProvider } from './types.js';

/**
 * OpenRouter (https://openrouter.ai) — an OpenAI-compatible gateway that fronts
 * many vendor models (anthropic/..., openai/..., ...) behind one API key.
 */
export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  private params() {
    if (!this.model) throw new LLMError('OPENROUTER_MODEL is not configured', 503);
    return {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: this.apiKey,
      model: this.model,
      label: 'OpenRouter',
      requireApiKey: true,
    };
  }

  async complete(opts: CompleteOptions): Promise<string> {
    return openAICompatibleComplete(this.params(), opts);
  }

  async chat(opts: ChatOptions): Promise<string> {
    return openAICompatibleChat(this.params(), opts);
  }
}
