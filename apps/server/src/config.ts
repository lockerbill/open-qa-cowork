/** Server configuration sourced from environment variables. */
export interface Config {
  port: number;
  provider: 'anthropic' | 'openai';
  anthropic: { apiKey: string; model: string };
  openai: { apiKey: string; model: string };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const provider = (env.LLM_PROVIDER ?? 'anthropic').toLowerCase();
  return {
    port: Number(env.PORT ?? 8787),
    provider: provider === 'openai' ? 'openai' : 'anthropic',
    anthropic: {
      apiKey: env.ANTHROPIC_API_KEY ?? '',
      model: env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
    },
    openai: {
      apiKey: env.OPENAI_API_KEY ?? '',
      model: env.OPENAI_MODEL ?? 'gpt-4o',
    },
  };
}
