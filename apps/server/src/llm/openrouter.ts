import { openAICompatibleComplete } from './openai-compatible.js';
import { LLMError, type CompleteOptions, type LLMProvider } from './types.js';

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

  async complete(opts: CompleteOptions): Promise<string> {
    if (!this.model) throw new LLMError('OPENROUTER_MODEL is not configured', 503);
    return openAICompatibleComplete(
      {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: this.apiKey,
        model: this.model,
        label: 'OpenRouter',
        requireApiKey: true,
      },
      opts,
    );
  }
}
