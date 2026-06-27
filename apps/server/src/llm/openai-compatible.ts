import { LLMError, type CompleteOptions } from './types.js';

export interface OpenAICompatParams {
  /** Base URL including the version path, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  /** Optional bearer key; omitted/empty is allowed for local servers. */
  apiKey?: string;
  model: string;
  /** Human-readable name used in error messages, e.g. 'OpenAI' | 'Local LLM'. */
  label: string;
  /** When true, an empty apiKey is a 503 configuration error. */
  requireApiKey?: boolean;
}

/**
 * Call any OpenAI-compatible chat completions endpoint (OpenAI itself, Ollama,
 * LM Studio, llama.cpp, vLLM, ...). Shared by the cloud OpenAI provider and the
 * local provider so the request/parse logic lives in one place.
 */
export async function openAICompatibleComplete(
  params: OpenAICompatParams,
  opts: CompleteOptions,
): Promise<string> {
  if (params.requireApiKey && !params.apiKey) {
    throw new LLMError(`${params.label} API key is not configured`, 503);
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (params.apiKey) {
    headers.authorization = `Bearer ${params.apiKey}`;
  }

  const res = await fetch(`${params.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: params.model,
      max_tokens: opts.maxTokens ?? 2048,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new LLMError(`${params.label} API ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new LLMError(`${params.label} returned no content`);
  return text;
}
