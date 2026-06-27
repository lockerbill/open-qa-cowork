import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createProvider } from './llm/index.js';

const config = loadConfig();
const provider = createProvider(config);
const app = createApp(provider);

app.listen(config.port, () => {
  console.log(
    `QA Copilot server listening on http://localhost:${config.port} (provider: ${provider.name})`,
  );
  if (
    (config.provider === 'anthropic' && !config.anthropic.apiKey) ||
    (config.provider === 'openai' && !config.openai.apiKey)
  ) {
    console.warn(
      `[warn] No API key set for "${config.provider}". ` +
        'Set ANTHROPIC_API_KEY or OPENAI_API_KEY for generation endpoints to work.',
    );
  }
});
