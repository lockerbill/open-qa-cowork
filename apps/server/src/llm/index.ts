import type { Config } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import type { LLMProvider } from './types.js';

export * from './types.js';

/** Select and build the configured provider (spec §12.2). */
export function createProvider(config: Config): LLMProvider {
  if (config.provider === 'openai') {
    return new OpenAIProvider(config.openai.apiKey, config.openai.model);
  }
  return new AnthropicProvider(config.anthropic.apiKey, config.anthropic.model);
}
