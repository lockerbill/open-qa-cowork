import { LLMError, type CompleteOptions, type LLMProvider } from './types.js';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async complete(opts: CompleteOptions): Promise<string> {
    if (!this.apiKey) {
      throw new LLMError('OPENAI_API_KEY is not configured', 503);
    }
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens ?? 2048,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new LLMError(`OpenAI API ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new LLMError('OpenAI returned no content');
    return text;
  }
}
