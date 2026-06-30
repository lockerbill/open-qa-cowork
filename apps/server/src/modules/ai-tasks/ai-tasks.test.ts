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
const MASTER_KEY = Buffer.alloc(32, 3).toString('base64');
const silent = createLogger('error', { write() {} });

const session = {
  id: 'session_1',
  status: 'stopped',
  events: [
    {
      id: 'e1',
      type: 'click',
      targetLabel: 'Submit',
      resultSummary: 'Error shown — contact admin@secret.example.com',
      timestamp: '2026-06-30T10:00:00Z',
    },
  ],
};

function mockFetchReturning(content: string) {
  const fn = vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }], usage: { completion_tokens: 50 } }),
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
    .send({ email: 'bug-owner@example.com', password: 'password123' });
  ownerToken = reg.body.token;
  workspaceId = reg.body.workspace.id;
});
afterEach(async () => {
  await close();
  vi.unstubAllGlobals();
});

async function configureDefaultProvider() {
  const created = await request(app)
    .post(`/api/workspaces/${workspaceId}/llm-providers`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      displayName: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelName: 'anthropic/claude-sonnet-4',
      apiKey: 'sk-test-key',
    });
  await request(app)
    .post(`/api/workspaces/${workspaceId}/llm-providers/${created.body.id}/set-default`)
    .set('Authorization', `Bearer ${ownerToken}`);
  return created.body.id as string;
}

function generateBugReport(token: string) {
  return request(app)
    .post(`/api/workspaces/${workspaceId}/ai/tasks/generate-bug-report`)
    .set('Authorization', `Bearer ${token}`)
    .send({ session, userNote: 'Expected validation error' });
}

describe('generate-bug-report (AI task slice)', () => {
  it('generates a report end-to-end and records run, usage, and audit', async () => {
    await configureDefaultProvider();
    mockFetchReturning('# Bug: Release date required\nSteps...');

    const res = await generateBugReport(ownerToken);
    expect(res.status).toBe(200);
    expect(res.body.taskRunId).toMatch(/^taskrun_/);
    expect(res.body.bugReport.content).toContain('Bug');
    expect(res.body.bugReport.format).toBe('markdown');

    const runs = await db.select().from(aiTaskRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');

    const usage = await db.select().from(usageLogs);
    expect(usage).toHaveLength(1);

    const actions = (await db.select().from(auditLogs)).map((e) => e.action);
    expect(actions).toContain('ai_task.started');
    expect(actions).toContain('ai_task.completed');
  });

  it('redacts the payload before it reaches the provider', async () => {
    await configureDefaultProvider();
    const fetchMock = mockFetchReturning('# Bug');

    await generateBugReport(ownerToken);

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    const userContent = body.messages[1].content as string;
    expect(userContent).not.toContain('admin@secret.example.com');
    expect(userContent).toContain('[EMAIL]');
  });

  it('forbids viewers from running AI tasks', async () => {
    await configureDefaultProvider();
    const viewerReg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'viewer@example.com', password: 'password123' });
    await addMember(db, { workspaceId, userId: viewerReg.body.user.id, role: 'viewer' });

    const res = await generateBugReport(viewerReg.body.token);
    expect(res.status).toBe(403);
  });

  it('returns a friendly error when no provider is configured', async () => {
    const res = await generateBugReport(ownerToken);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('no_provider');
  });

  it('records a failed run with a correlation id when the provider errors', async () => {
    await configureDefaultProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 401, text: async () => 'bad key' })),
    );

    const res = await generateBugReport(ownerToken);
    expect(res.status).toBe(502);
    expect(res.body.taskRunId).toMatch(/^taskrun_/);

    const runs = await db.select().from(aiTaskRuns);
    expect(runs[0]!.status).toBe('failed');
  });
});
