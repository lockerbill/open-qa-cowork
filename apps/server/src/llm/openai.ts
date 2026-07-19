import { openAICompatibleChat, openAICompatibleComplete } from './openai-compatible.js';
import type { ChatOptions, CompleteOptions, LLMProvider } from './types.js';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  private params() {
    return {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: this.apiKey,
      model: this.model,
      label: 'OpenAI',
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
