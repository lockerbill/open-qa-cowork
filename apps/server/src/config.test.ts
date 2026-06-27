import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';
import { createProvider } from './llm/index.js';

describe('loadConfig', () => {
  it('defaults to the anthropic provider', () => {
    expect(loadConfig({}).provider).toBe('anthropic');
  });

  it('recognizes the local provider and populates its config', () => {
    const config = loadConfig({
      LLM_PROVIDER: 'local',
      LOCAL_BASE_URL: 'http://localhost:11434/v1',
      LOCAL_MODEL: 'llama3.1',
      LOCAL_API_KEY: 'token',
    });
    expect(config.provider).toBe('local');
    expect(config.local).toEqual({
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.1',
      apiKey: 'token',
    });
  });

  it('defaults the local block to empty strings when unset', () => {
    expect(loadConfig({ LLM_PROVIDER: 'local' }).local).toEqual({
      baseUrl: '',
      model: '',
      apiKey: '',
    });
  });

  it('normalizes an unknown provider to anthropic', () => {
    expect(loadConfig({ LLM_PROVIDER: 'bogus' }).provider).toBe('anthropic');
  });
});

describe('createProvider', () => {
  it('builds a provider named "local" for the local config', () => {
    const config = loadConfig({
      LLM_PROVIDER: 'local',
      LOCAL_BASE_URL: 'http://localhost:11434/v1',
      LOCAL_MODEL: 'llama3.1',
    });
    expect(createProvider(config).name).toBe('local');
  });
});
