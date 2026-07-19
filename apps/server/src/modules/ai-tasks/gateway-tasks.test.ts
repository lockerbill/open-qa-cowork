import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { createTestDb } from '../../db/testing.js';
import { createLogger } from '../../logging/logger.js';
import { aiTaskRuns, usageLogs, auditLogs } from '../../db/schema.js';
import type { Database } from '../../db/client.js';
import type { CompleteOptions, LLMProvider } from '../../llm/index.js';
import { addMember } from '../workspaces/service.js';

class MockProvider implements LLMProvider {
  readonly name = 'mock';
  async complete(_opts: CompleteOptions): Promise<string> {
    return '';
  }
}

const JWT = 'test-secret';
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const silent = createLogger('error', { write() {} });

// A pageModel carrying PII (email) to confirm redaction before the provider call.
const pageModel = {
  summary: { url: 'https://app.example.com/orders' },
  elements: [{ tag: 'label', text: 'Contact admin@secret.example.com for help' }],
  capturedAt: '2026-06-30T10:00:00Z',
};
const session = { id: 'session_1', status: 'stopped', events: [] };

function mockFetchReturning(content: string) {
  const fn = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 120, completion_tokens: 50 },
    }),
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

let db: Database;
let close: () => Promise<void>;
let app: Express;
let ownerToken: string;
let workspaceId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  app = createApp(new MockProvider(), silent, {
    db,
    jwtSecret: JWT,
    masterEncryptionKey: MASTER_KEY,
    allowPrivateLlmHosts: true,
  });
  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email: 'gw-owner@example.com', password: 'password123' });
  ownerToken = reg.body.token;
  workspaceId = reg.body.workspace.id;
});
afterEach(async () => {
  await close();
  vi.unstubAllGlobals();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const url = (path: string) => `/api/workspaces/${workspaceId}/ai/tasks/${path}`;

async function configureDefaultProvider() {
  const created = await request(app)
    .post(`/api/workspaces/${workspaceId}/llm-providers`)
    .set(auth(ownerToken))
    .send({
      displayName: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelName: 'anthropic/claude-sonnet-4',
      apiKey: 'sk-test-key',
    });
  await request(app)
    .post(`/api/workspaces/${workspaceId}/llm-providers/${created.body.id}/set-default`)
    .set(auth(ownerToken));
}

describe('analyze-page (gateway)', () => {
  it('returns structured analysis and records run/usage/audit', async () => {
    await configureDefaultProvider();
    mockFetchReturning('{"summary":"Looks ok","risks":["r1"],"suggestedTests":["t1"]}');

    const res = await request(app).post(url('analyze-page')).set(auth(ownerToken)).send({ pageModel });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ summary: 'Looks ok', risks: ['r1'], suggestedTests: ['t1'] });

    const runs = await db.select().from(aiTaskRuns);
    expect(runs[0]!.taskType).toBe('analyze_page');
    expect(runs[0]!.status).toBe('succeeded');
    const usage = await db.select().from(usageLogs);
    expect(usage[0]!.taskType).toBe('analyze_page');
    expect(usage[0]!.inputTokens).toBe(120);
    const actions = (await db.select().from(auditLogs)).map((e) => e.action);
    expect(actions).toContain('ai_task.started');
    expect(actions).toContain('ai_task.completed');
  });

  it('falls back to a hint on malformed JSON', async () => {
    await configureDefaultProvider();
    mockFetchReturning('{"summary": "truncated...');
    const res = await request(app).post(url('analyze-page')).set(auth(ownerToken)).send({ pageModel });
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatch(/malformed or truncated/i);
    expect(res.body.risks).toEqual([]);
  });

  it('redacts PII before the payload reaches the provider', async () => {
    await configureDefaultProvider();
    const fetchMock = mockFetchReturning('{"summary":"s","risks":[],"suggestedTests":[]}');
    await request(app).post(url('analyze-page')).set(auth(ownerToken)).send({ pageModel });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const userContent = body.messages[1].content as string;
    expect(userContent).not.toContain('admin@secret.example.com');
    expect(userContent).toContain('[EMAIL]');
  });

  it('forbids viewers', async () => {
    await configureDefaultProvider();
    const viewer = await request(app)
      .post('/api/auth/register')
      .send({ email: 'gw-viewer@example.com', password: 'password123' });
    await addMember(db, { workspaceId, userId: viewer.body.user.id, role: 'viewer' });
    const res = await request(app)
      .post(url('analyze-page'))
      .set(auth(viewer.body.token))
      .send({ pageModel });
    expect(res.status).toBe(403);
  });

  it('returns 409 when no provider is configured', async () => {
    const res = await request(app).post(url('analyze-page')).set(auth(ownerToken)).send({ pageModel });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('no_provider');
  });
});

describe('generate-test-cases (gateway)', () => {
  it('returns a markdown artifact and records the run', async () => {
    await configureDefaultProvider();
    mockFetchReturning('## TC-1\nSteps...');
    const res = await request(app)
      .post(url('generate-test-cases'))
      .set(auth(ownerToken))
      .send({ pageModel, focus: 'negative' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('test_cases');
    expect(res.body.format).toBe('markdown');
    expect(res.body.content).toContain('TC-1');

    const runs = await db.select().from(aiTaskRuns);
    expect(runs[0]!.taskType).toBe('generate_test_cases');
    expect(runs[0]!.status).toBe('succeeded');
  });
});

describe('enrich-playwright (gateway)', () => {
  it('returns the enriched spec when enrichment succeeds', async () => {
    await configureDefaultProvider();
    mockFetchReturning('// enriched\nimport { test } from "@playwright/test";');
    const res = await request(app)
      .post(url('enrich-playwright'))
      .set(auth(ownerToken))
      .send({ session, enrich: true });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('playwright_test');
    expect(res.body.content).toContain('enriched');

    const runs = await db.select().from(aiTaskRuns);
    expect(runs[0]!.taskType).toBe('enrich_playwright');
    expect(runs[0]!.status).toBe('succeeded');
  });

  it('falls back to the deterministic draft and records a failed run on provider error', async () => {
    await configureDefaultProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, text: async () => 'bad key' })),
    );
    const res = await request(app)
      .post(url('enrich-playwright'))
      .set(auth(ownerToken))
      .send({ session, enrich: true });
    expect(res.status).toBe(200); // best-effort: deterministic draft still returned
    expect(res.body.type).toBe('playwright_test');
    expect(res.body.content.length).toBeGreaterThan(0);

    const runs = await db.select().from(aiTaskRuns);
    expect(runs[0]!.taskType).toBe('enrich_playwright');
    expect(runs[0]!.status).toBe('failed');
  });

  it('skips the LLM entirely when enrich is not requested', async () => {
    await configureDefaultProvider();
    const fetchMock = mockFetchReturning('// should not be called');
    const res = await request(app)
      .post(url('enrich-playwright'))
      .set(auth(ownerToken))
      .send({ session });
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    const runs = await db.select().from(aiTaskRuns);
    expect(runs).toHaveLength(0);
  });
});
