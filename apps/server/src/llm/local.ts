import { openAICompatibleComplete } from './openai-compatible.js';
import { LLMError, type CompleteOptions, type LLMProvider } from './types.js';

export interface LocalConfig {
  /** OpenAI-compatible base URL including /v1, e.g. http://localhost:11434/v1 */
  baseUrl: string;
  model: string;
  /** Usually blank; set only if the local server requires a bearer token. */
  apiKey: string;
}

/** Local model served via any OpenAI-compatible endpoint (spec §12.2). */
export class LocalProvider implements LLMProvider {
  readonly name = 'local';

  constructor(private readonly cfg: LocalConfig) {}

  async complete(opts: CompleteOptions): Promise<string> {
    if (!this.cfg.baseUrl) throw new LLMError('LOCAL_BASE_URL is not configured', 503);
    if (!this.cfg.model) throw new LLMError('LOCAL_MODEL is not configured', 503);
    return openAICompatibleComplete(
      {
        baseUrl: this.cfg.baseUrl,
        apiKey: this.cfg.apiKey,
        model: this.cfg.model,
        label: 'Local LLM',
        requireApiKey: false,
      },
      opts,
    );
  }
}
