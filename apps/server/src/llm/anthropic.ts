import { LLMError, type CompleteOptions, type LLMProvider } from './types.js';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async complete(opts: CompleteOptions): Promise<string> {
    if (!this.apiKey) {
      throw new LLMError('ANTHROPIC_API_KEY is not configured', 503);
    }
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens ?? 2048,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new LLMError(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.find((c) => c.type === 'text')?.text;
    if (!text) throw new LLMError('Anthropic returned no text content');
    return text;
  }
}
