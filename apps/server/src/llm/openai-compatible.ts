import {
  LLMError,
  type ChatOptions,
  type ChatToolsOptions,
  type CompleteOptions,
  type ToolCallResult,
} from './types.js';

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
  /**
   * Extra fields shallow-merged into the request body. Used by the local
   * provider to pass server-specific knobs (e.g. vLLM's chat_template_kwargs).
   * Do NOT set this for cloud providers — they reject unknown body fields.
   */
  extraBody?: Record<string, unknown>;
  /** Abort the request after this many ms. Omitted/0 means wait indefinitely. */
  timeoutMs?: number;
  /**
   * Redirect handling passed to fetch. The BYO provider path sets `'error'` so a
   * malicious endpoint cannot redirect into an internal address (SSRF bypass).
   * Defaults to fetch's behaviour (follow) for the trusted env-configured paths.
   */
  redirect?: RequestRedirect;
}

interface ChatCompletionResponse {
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: { function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface CompletionUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface CompletionWithUsage {
  text: string;
  usage: CompletionUsage;
}

/** Remove inline <think>...</think> reasoning blocks some servers leave in `content`. */
function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Like {@link openAICompatibleComplete} but also returns the provider's token
 * usage (`prompt_tokens` / `completion_tokens`, null when the server omits
 * them). Used by the audited workspace gateway to record usage.
 */
export async function openAICompatibleCompleteWithUsage(
  params: OpenAICompatParams,
  opts: CompleteOptions,
): Promise<CompletionWithUsage> {
  return openAICompatibleChatWithUsage(params, {
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
    maxTokens: opts.maxTokens,
  });
}

/**
 * POST /chat/completions on any OpenAI-compatible endpoint with shared
 * auth/timeout/error handling. This is the single place the request logic
 * lives; the text and tool-call helpers both wrap it.
 */
async function postChatCompletions(
  params: OpenAICompatParams,
  body: Record<string, unknown>,
): Promise<ChatCompletionResponse> {
  if (params.requireApiKey && !params.apiKey) {
    throw new LLMError(`${params.label} API key is not configured`, 503);
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (params.apiKey) {
    headers.authorization = `Bearer ${params.apiKey}`;
  }

  const controller = params.timeoutMs ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), params.timeoutMs) : undefined;

  let res: Response;
  try {
    res = await fetch(`${params.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller?.signal,
      redirect: params.redirect,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new LLMError(`${params.label} timed out after ${params.timeoutMs}ms`, 504);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new LLMError(`${params.label} API ${res.status}: ${errBody.slice(0, 300)}`);
  }
  return (await res.json()) as ChatCompletionResponse;
}

function usageOf(data: ChatCompletionResponse): CompletionUsage {
  return {
    inputTokens: data.usage?.prompt_tokens ?? null,
    outputTokens: data.usage?.completion_tokens ?? null,
  };
}

/**
 * Call any OpenAI-compatible chat completions endpoint (OpenAI itself, Ollama,
 * LM Studio, llama.cpp, vLLM, ...) with a full message history, returning the
 * completion text alongside the provider's token usage.
 */
export async function openAICompatibleChatWithUsage(
  params: OpenAICompatParams,
  opts: ChatOptions,
): Promise<CompletionWithUsage> {
  const data = await postChatCompletions(params, {
    model: params.model,
    max_tokens: opts.maxTokens ?? 2048,
    messages: opts.messages,
    ...params.extraBody,
  });
  const choice = data.choices?.[0];
  const usage = usageOf(data);
  const text = stripThinkTags(choice?.message?.content ?? '');
  if (text) return { text, usage };

  // Empty content. For reasoning models (e.g. Qwen3) this usually means the
  // token budget was spent thinking before any answer was emitted. Surface the
  // finish_reason / token usage so the failure is diagnosable instead of opaque.
  const finishReason = choice?.finish_reason ?? 'unknown';
  const completionTokens = data.usage?.completion_tokens;
  const hint =
    finishReason === 'length'
      ? ' — the model may have spent its token budget thinking; raise LOCAL_MAX_TOKENS or disable thinking'
      : '';
  const tokens = completionTokens != null ? `, completion_tokens=${completionTokens}` : '';
  throw new LLMError(`${params.label} returned no content (finish_reason=${finishReason}${tokens})${hint}`);
}

/**
 * Multi-turn chat over any OpenAI-compatible endpoint. Returns only the
 * completion text; use {@link openAICompatibleChatWithUsage} when token usage
 * is needed.
 */
export async function openAICompatibleChat(
  params: OpenAICompatParams,
  opts: ChatOptions,
): Promise<string> {
  const { text } = await openAICompatibleChatWithUsage(params, opts);
  return text;
}

/**
 * Single-turn completion over any OpenAI-compatible endpoint. Thin wrapper that
 * frames the system + user prompt as a two-message chat. Returns only the
 * completion text; use {@link openAICompatibleCompleteWithUsage} when token
 * usage is needed.
 */
export async function openAICompatibleComplete(
  params: OpenAICompatParams,
  opts: CompleteOptions,
): Promise<string> {
  const { text } = await openAICompatibleCompleteWithUsage(params, opts);
  return text;
}

export interface ToolCallsWithUsage {
  result: ToolCallResult;
  usage: CompletionUsage;
}

/**
 * Tool-calling chat over any OpenAI-compatible endpoint (auto-test-mode-spec
 * §8.3): registers the tools, forces `tool_choice: 'required'`, and returns
 * every tool call the provider emitted (callers take the first and warn on
 * extras). Malformed per-call argument JSON yields `input: null` with the raw
 * payload kept for recovery parsing.
 */
export async function openAICompatibleChatWithTools(
  params: OpenAICompatParams,
  opts: ChatToolsOptions,
): Promise<ToolCallsWithUsage> {
  const effective = opts.timeoutMs ? { ...params, timeoutMs: opts.timeoutMs } : params;
  const data = await postChatCompletions(effective, {
    model: params.model,
    max_tokens: opts.maxTokens ?? 2048,
    messages: opts.messages,
    tools: opts.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    })),
    tool_choice: 'required',
    ...params.extraBody,
  });
  const choice = data.choices?.[0];
  const toolCalls = (choice?.message?.tool_calls ?? []).flatMap((call) => {
    const name = call.function?.name;
    if (!name) return [];
    const rawArguments = call.function?.arguments ?? '';
    let input: unknown = null;
    try {
      input = rawArguments ? JSON.parse(rawArguments) : {};
    } catch {
      input = null;
    }
    return [{ name, input, rawArguments }];
  });
  const text = stripThinkTags(choice?.message?.content ?? '');
  return {
    result: { toolCalls, ...(text ? { text } : {}) },
    usage: usageOf(data),
  };
}
