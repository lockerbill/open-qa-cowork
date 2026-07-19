import 'dotenv/config';
import { createApp, type PlatformDeps } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { createProvider } from './llm/index.js';
import { createLogger } from './logging/logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const provider = createProvider(config, logger);

let platform: PlatformDeps | undefined;
if (config.databaseUrl && config.jwtSecret && config.masterEncryptionKey) {
  const { db } = createDb(config.databaseUrl);
  platform = {
    db,
    jwtSecret: config.jwtSecret,
    masterEncryptionKey: config.masterEncryptionKey,
    allowPrivateLlmHosts: config.allowPrivateLlmHosts,
  };
} else {
  logger.warn(
    { event: 'server.platform_disabled' },
    'Multi-user platform disabled: set DATABASE_URL, JWT_SECRET and MASTER_ENCRYPTION_KEY to enable /api/auth, /api/workspaces and BYO LLM.',
  );
}

const app = createApp(provider, logger, platform);

app.listen(config.port, config.host, () => {
  logger.info(
    {
      event: 'server.start',
      host: config.host,
      port: config.port,
      provider: provider.name,
      logLevel: config.logLevel,
    },
    `QA Copilot server listening on http://${config.host}:${config.port} (provider: ${provider.name})`,
  );
  if (
    (config.provider === 'anthropic' && !config.anthropic.apiKey) ||
    (config.provider === 'openai' && !config.openai.apiKey)
  ) {
    logger.warn(
      { event: 'server.no_api_key', provider: config.provider },
      `No API key set for "${config.provider}". ` +
        'Set ANTHROPIC_API_KEY or OPENAI_API_KEY for generation endpoints to work.',
    );
  }
});
