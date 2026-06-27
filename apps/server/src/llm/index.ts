import type { Config } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { LocalProvider } from './local.js';
import { OpenAIProvider } from './openai.js';
import { OpenRouterProvider } from './openrouter.js';
import type { LLMProvider } from './types.js';

export * from './types.js';

/** Select and build the configured provider (spec §12.2). */
export function createProvider(config: Config): LLMProvider {
  if (config.provider === 'local') {
    return new LocalProvider(config.local);
  }
  if (config.provider === 'openai') {
    return new OpenAIProvider(config.openai.apiKey, config.openai.model);
  }
  if (config.provider === 'openrouter') {
    return new OpenRouterProvider(config.openrouter.apiKey, config.openrouter.model);
  }
  return new AnthropicProvider(config.anthropic.apiKey, config.anthropic.model);
}
