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

  it('recognizes the openrouter provider and populates its config', () => {
    const config = loadConfig({
      LLM_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'sk-or-key',
      OPENROUTER_MODEL: 'anthropic/claude-sonnet-4-6',
    });
    expect(config.provider).toBe('openrouter');
    expect(config.openrouter).toEqual({
      apiKey: 'sk-or-key',
      model: 'anthropic/claude-sonnet-4-6',
    });
  });

  it('defaults the openrouter block to empty strings when unset', () => {
    expect(loadConfig({ LLM_PROVIDER: 'openrouter' }).openrouter).toEqual({
      apiKey: '',
      model: '',
    });
  });

  it('normalizes an unknown provider to anthropic', () => {
    expect(loadConfig({ LLM_PROVIDER: 'bogus' }).provider).toBe('anthropic');
  });

  it('defaults the log level to info', () => {
    expect(loadConfig({}).logLevel).toBe('info');
  });

  it('reads a valid LOG_LEVEL', () => {
    expect(loadConfig({ LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
  });

  it('clamps an unknown LOG_LEVEL to info', () => {
    expect(loadConfig({ LOG_LEVEL: 'bogus' }).logLevel).toBe('info');
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

  it('builds a provider named "openrouter" for the openrouter config', () => {
    const config = loadConfig({
      LLM_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'sk-or-key',
      OPENROUTER_MODEL: 'anthropic/claude-sonnet-4-6',
    });
    expect(createProvider(config).name).toBe('openrouter');
  });
});
