import type { Config } from '../config.js';
import { defaultLogger, type Logger } from '../logging/logger.js';
import { AnthropicProvider } from './anthropic.js';
import { LocalProvider } from './local.js';
import { LoggingProvider } from './logging-provider.js';
import { OpenAIProvider } from './openai.js';
import { OpenRouterProvider } from './openrouter.js';
import type { LLMProvider } from './types.js';

export * from './types.js';

/** Select and build the configured provider (spec §12.2), wrapped for tracing. */
export function createProvider(config: Config, logger: Logger = defaultLogger()): LLMProvider {
  const { inner, model } = buildProvider(config);
  return new LoggingProvider(inner, logger, model);
}

function buildProvider(config: Config): { inner: LLMProvider; model: string } {
  if (config.provider === 'local') {
    return { inner: new LocalProvider(config.local), model: config.local.model };
  }
  if (config.provider === 'openai') {
    return {
      inner: new OpenAIProvider(config.openai.apiKey, config.openai.model),
      model: config.openai.model,
    };
  }
  if (config.provider === 'openrouter') {
    return {
      inner: new OpenRouterProvider(config.openrouter.apiKey, config.openrouter.model),
      model: config.openrouter.model,
    };
  }
  return {
    inner: new AnthropicProvider(config.anthropic.apiKey, config.anthropic.model),
    model: config.anthropic.model,
  };
}
