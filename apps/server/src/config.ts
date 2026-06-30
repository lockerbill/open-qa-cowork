import { parseLogLevel, type LogLevel } from './logging/logger.js';

/** Server configuration sourced from environment variables. */
export interface Config {
  port: number;
  logLevel: LogLevel;
  /** Postgres connection string for the multi-user platform tables. */
  databaseUrl: string;
  /** Secret used to sign/verify auth JWTs. */
  jwtSecret: string;
  /** Base64-encoded 32-byte key for the AES-256-GCM secret vault. */
  masterEncryptionKey: string;
  /** Allow BYO provider base URLs that resolve to private/reserved hosts (local LLMs). */
  allowPrivateLlmHosts: boolean;
  provider: 'anthropic' | 'openai' | 'local' | 'openrouter';
  anthropic: { apiKey: string; model: string };
  openai: { apiKey: string; model: string };
  local: {
    baseUrl: string;
    model: string;
    apiKey: string;
    enableThinking: boolean;
    maxTokens?: number;
    timeoutMs: number;
  };
  openrouter: { apiKey: string; model: string };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const provider = (env.LLM_PROVIDER ?? 'anthropic').toLowerCase();
  return {
    port: Number(env.PORT ?? 8787),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    databaseUrl: env.DATABASE_URL ?? '',
    jwtSecret: env.JWT_SECRET ?? '',
    masterEncryptionKey: env.MASTER_ENCRYPTION_KEY ?? '',
    allowPrivateLlmHosts: env.ALLOW_PRIVATE_LLM_HOSTS === 'true',
    provider:
      provider === 'openai'
        ? 'openai'
        : provider === 'local'
          ? 'local'
          : provider === 'openrouter'
            ? 'openrouter'
            : 'anthropic',
    anthropic: {
      apiKey: env.ANTHROPIC_API_KEY ?? '',
      model: env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
    },
    openai: {
      apiKey: env.OPENAI_API_KEY ?? '',
      model: env.OPENAI_MODEL ?? 'gpt-4o',
    },
    local: {
      baseUrl: env.LOCAL_BASE_URL ?? '',
      model: env.LOCAL_MODEL ?? '',
      apiKey: env.LOCAL_API_KEY ?? '',
      enableThinking: env.LOCAL_ENABLE_THINKING === 'true',
      maxTokens: Number(env.LOCAL_MAX_TOKENS) || undefined,
      timeoutMs: Number(env.LOCAL_TIMEOUT_MS) || 120000,
    },
    openrouter: {
      apiKey: env.OPENROUTER_API_KEY ?? '',
      model: env.OPENROUTER_MODEL ?? '',
    },
  };
}
