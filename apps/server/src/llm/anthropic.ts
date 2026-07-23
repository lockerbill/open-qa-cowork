import {
  LLMError,
  type ChatMessage,
  type ChatOptions,
  type ChatToolsOptions,
  type CompleteOptions,
  type LLMProvider,
  type ToolCallResult,
} from './types.js';

interface AnthropicContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async complete(opts: CompleteOptions): Promise<string> {
    return this.chat({
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      maxTokens: opts.maxTokens,
    });
  }

  async chat(opts: ChatOptions): Promise<string> {
    const data = await this.request({
      messages: opts.messages,
      maxTokens: opts.maxTokens,
    });
    const text = data.content?.find((c) => c.type === 'text')?.text;
    if (!text) throw new LLMError('Anthropic returned no text content');
    return text;
  }

  /**
   * Tool-calling capability (auto-test-mode-spec §8.3): `tool_choice: any`
   * forces a tool call; every returned call is surfaced so the caller can take
   * the first and warn on extras.
   */
  async chatWithTools(opts: ChatToolsOptions): Promise<ToolCallResult> {
    const data = await this.request({
      messages: opts.messages,
      maxTokens: opts.maxTokens,
      timeoutMs: opts.timeoutMs,
      extra: {
        tools: opts.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        })),
        tool_choice: { type: 'any' },
      },
    });
    const blocks = data.content ?? [];
    const toolCalls = blocks
      .filter((block) => block.type === 'tool_use' && typeof block.name === 'string')
      .map((block) => ({ name: block.name!, input: block.input ?? {} }));
    const text = blocks.find((block) => block.type === 'text')?.text;
    return { toolCalls, ...(text ? { text } : {}) };
  }

  private async request(args: {
    messages: ChatMessage[];
    maxTokens?: number;
    timeoutMs?: number;
    extra?: Record<string, unknown>;
  }): Promise<{ content?: AnthropicContentBlock[] }> {
    if (!this.apiKey) {
      throw new LLMError('ANTHROPIC_API_KEY is not configured', 503);
    }
    // Anthropic requires the system prompt as a top-level field, not a message.
    // Pull any system messages out of the history and join them.
    const system = args.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    const messages = args.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const controller = args.timeoutMs ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), args.timeoutMs) : undefined;

    let res: Response;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: args.maxTokens ?? 2048,
          ...(system ? { system } : {}),
          messages,
          ...args.extra,
        }),
        signal: controller?.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new LLMError(`Anthropic timed out after ${args.timeoutMs}ms`, 504);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new LLMError(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as { content?: AnthropicContentBlock[] };
  }
}
