/**
 * Provider adaptation for POST /auto/step (auto-test-mode-spec §8.3): try the
 * tool-calling path first (`tool_choice: required`, one tool per action type);
 * providers that reject the request with a 4xx (no function-calling support —
 * local/Ollama setups) fall back to JSON mode in the same request. Both paths
 * produce a raw candidate that funnels into validate.ts.
 */
import net from 'node:net';
import { actionToolDefs } from '@qa-copilot/shared/auto';
import { parseJsonLoose } from '../../http/util.js';
import type { Logger } from '../../logging/logger.js';
import { isPrivateOrReservedIp } from '../providers/ssrf.js';
import {
  openAICompatibleChatWithTools,
  openAICompatibleChatWithUsage,
  type CompletionUsage,
  type OpenAICompatParams,
} from '../../llm/openai-compatible.js';
import { LLMError, type ChatMessage } from '../../llm/types.js';
import { JSON_MODE_INSTRUCTION } from './prompt.js';

export interface DecideOutcome {
  /** Raw candidate action (pre-validation); null when nothing parseable came back. */
  candidate: unknown;
  /** Verbatim model output for AUTO_STEP_DEBUG=1 422 responses. */
  modelRaw: string;
  usage: CompletionUsage;
  path: 'tools' | 'json';
}

/** Sum usage across the tools attempt and a JSON fallback (both were billed). */
function addUsage(a: CompletionUsage, b: CompletionUsage): CompletionUsage {
  const add = (x: number | null, y: number | null) => (x === null && y === null ? null : (x ?? 0) + (y ?? 0));
  return { inputTokens: add(a.inputTokens, b.inputTokens), outputTokens: add(a.outputTokens, b.outputTokens) };
}

/** A 4xx from the provider on the tools request ⇒ likely no tool support. */
function looksLikeToolRejection(err: unknown): boolean {
  return err instanceof LLMError && err.status === 502 && /API 4\d\d/.test(err.message);
}

/**
 * Reasoning models (Qwen3 etc.) served locally can burn the whole output
 * budget thinking, leaving `content` empty — a documented failure class this
 * repo already disables thinking for on the env-configured local provider.
 * BYO configs carry no such knob, so apply the same default for private-host
 * (local) providers: vLLM/SGLang honor `chat_template_kwargs`, other local
 * servers ignore it, and cloud APIs — which may reject unknown body fields —
 * never get it (their hosts are public).
 */
export function localModelExtraBody(baseUrl: string): Record<string, unknown> | undefined {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const isLocal =
      host === 'localhost' ||
      host.endsWith('.local') ||
      (net.isIP(host) !== 0 && isPrivateOrReservedIp(host));
    return isLocal ? { chat_template_kwargs: { enable_thinking: false } } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decide the next action against an OpenAI-compatible endpoint. Multi-tool
 * responses take the first call and warn on extras (§8.3); malformed tool
 * arguments are recovered with the loose JSON parser before giving up.
 */
export async function decideCandidate(
  params: OpenAICompatParams,
  prompt: { system: string; user: string },
  logger: Logger,
  maxTokens: number,
): Promise<DecideOutcome> {
  const messages: ChatMessage[] = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ];

  let toolsUsage: CompletionUsage = { inputTokens: null, outputTokens: null };
  try {
    const { result, usage } = await openAICompatibleChatWithTools(params, {
      messages,
      tools: actionToolDefs(),
      maxTokens,
    });
    toolsUsage = usage;

    if (result.toolCalls.length > 0) {
      if (result.toolCalls.length > 1) {
        logger.warn(
          {
            event: 'auto.multi_tool',
            provider: params.label,
            count: result.toolCalls.length,
            names: result.toolCalls.map((c) => c.name),
          },
          'provider returned multiple tool calls; taking the first',
        );
      }
      const first = result.toolCalls[0]!;
      const input = first.input ?? parseJsonLoose<Record<string, unknown>>(first.rawArguments ?? '');
      const candidate =
        input !== null && typeof input === 'object'
          ? { ...(input as Record<string, unknown>), type: first.name }
          : null;
      return { candidate, modelRaw: JSON.stringify(result), usage, path: 'tools' };
    }

    // tool_choice was required but no call came back; some servers answer in
    // text anyway — recover it as JSON before falling back to a second call.
    if (result.text) {
      const candidate = parseJsonLoose<Record<string, unknown>>(result.text);
      if (candidate !== null) return { candidate, modelRaw: result.text, usage, path: 'tools' };
    }
  } catch (err) {
    if (!looksLikeToolRejection(err)) throw err;
    logger.info(
      { event: 'auto.tools_unsupported', provider: params.label },
      'provider rejected tool calling; falling back to JSON mode',
    );
  }

  // JSON-mode path (§8.3): append the JSON-only response-format instruction;
  // parse via strip fences -> JSON.parse -> first-{-to-last-} substring.
  const { text, usage: jsonUsage } = await openAICompatibleChatWithUsage(params, {
    messages: [
      messages[0]!,
      { role: 'user', content: `${prompt.user}\n\n${JSON_MODE_INSTRUCTION}` },
    ],
    maxTokens,
  });
  return {
    candidate: parseJsonLoose<Record<string, unknown>>(text),
    modelRaw: text,
    usage: addUsage(toolsUsage, jsonUsage),
    path: 'json',
  };
}
