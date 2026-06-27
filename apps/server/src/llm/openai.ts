import { openAICompatibleComplete } from './openai-compatible.js';
import type { CompleteOptions, LLMProvider } from './types.js';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async complete(opts: CompleteOptions): Promise<string> {
    return openAICompatibleComplete(
      {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: this.apiKey,
        model: this.model,
        label: 'OpenAI',
        requireApiKey: true,
      },
      opts,
    );
  }
}
