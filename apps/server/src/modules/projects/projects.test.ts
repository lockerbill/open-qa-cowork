import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { createTestDb } from '../../db/testing.js';
import { createLogger } from '../../logging/logger.js';
import { aiTaskRuns, auditLogs, projects as projectsTable } from '../../db/schema.js';
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
const MASTER_KEY = Buffer.alloc(32, 5).toString('base64');
const silent = createLogger('error', { write() {} });

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
    .send({ email: 'proj-owner@example.com', password: 'password123' });
  ownerToken = reg.body.token;
  workspaceId = reg.body.workspace.id;
});
afterEach(async () => {
  await close();
  vi.unstubAllGlobals();
});

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function createProject(token: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/workspaces/${workspaceId}/projects`)
    .set(auth(token))
    .send(body);
}

/** Register a second user and add them to the workspace with a role. Returns their token. */
async function memberWithRole(email: string, role: string): Promise<string> {
  const reg = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
  await addMember(db, { workspaceId, userId: reg.body.user.id, role: role as never });
  return reg.body.token as string;
}

async function createProvider(displayName: string): Promise<string> {
  const created = await request(app)
    .post(`/api/workspaces/${workspaceId}/llm-providers`)
    .set(auth(ownerToken))
    .send({
      displayName,
      baseUrl: 'https://openrouter.ai/api/v1',
      modelName: 'anthropic/claude-sonnet-4',
      apiKey: 'sk-test-key',
    });
  return created.body.id as string;
}

describe('projects CRUD + RBAC', () => {
  it('creates a project, uppercases the key, and writes an audit event', async () => {
    const res = await createProject(ownerToken, { name: 'ERP Web App', key: 'erp' });
    expect(res.status).toBe(201);
    expect(res.body.key).toBe('ERP');

    const rows = await db.select().from(projectsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe('ERP');

    const actions = (await db.select().from(auditLogs)).map((e) => e.action);
    expect(actions).toContain('project.created');
  });

  it('lists projects and fetches one; hides cross-workspace projects with 404', async () => {
    const created = await createProject(ownerToken, { name: 'ERP', key: 'ERP' });
    const list = await request(app)
      .get(`/api/workspaces/${workspaceId}/projects`)
      .set(auth(ownerToken));
    expect(list.body.projects).toHaveLength(1);

    // A second workspace owned by another user cannot see this project.
    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'other@example.com', password: 'password123' });
    const otherWs = other.body.workspace.id as string;
    const cross = await request(app)
      .get(`/api/workspaces/${otherWs}/projects/${created.body.id}`)
      .set(auth(other.body.token));
    expect(cross.status).toBe(404);
  });

  it('rejects a duplicate key in the same workspace but allows it in another', async () => {
    await createProject(ownerToken, { name: 'ERP', key: 'ERP' });
    const dup = await createProject(ownerToken, { name: 'ERP 2', key: 'erp' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('project_key_conflict');

    const other = await request(app)
      .post('/api/auth/register')
      .send({ email: 'other2@example.com', password: 'password123' });
    const otherWs = other.body.workspace.id as string;
    const ok = await request(app)
      .post(`/api/workspaces/${otherWs}/projects`)
      .set(auth(other.body.token))
      .send({ name: 'ERP', key: 'ERP' });
    expect(ok.status).toBe(201);
  });

  it('enforces the role matrix: qa_lead may create, viewer/tester may not', async () => {
    const qaLead = await memberWithRole('lead@example.com', 'qa_lead');
    const tester = await memberWithRole('tester@example.com', 'tester');
    const viewer = await memberWithRole('viewer@example.com', 'viewer');

    expect((await createProject(qaLead, { name: 'A', key: 'A' })).status).toBe(201);
    expect((await createProject(tester, { name: 'B', key: 'B' })).status).toBe(403);
    expect((await createProject(viewer, { name: 'C', key: 'C' })).status).toBe(403);

    // ...but viewers/testers can still read.
    const list = await request(app)
      .get(`/api/workspaces/${workspaceId}/projects`)
      .set(auth(viewer));
    expect(list.status).toBe(200);
  });
});

describe('environments', () => {
  let projectId: string;
  beforeEach(async () => {
    projectId = (await createProject(ownerToken, { name: 'ERP', key: 'ERP' })).body.id;
  });

  function createEnv(body: Record<string, unknown>) {
    return request(app)
      .post(`/api/workspaces/${workspaceId}/projects/${projectId}/environments`)
      .set(auth(ownerToken))
      .send(body);
  }

  it('seeds safe defaults by name and honors overrides', async () => {
    const prod = await createEnv({ name: 'production' });
    expect(prod.status).toBe(201);
    expect(prod.body.allowAiExecute).toBe(false);
    expect(prod.body.allowAutoSubmit).toBe(false);

    const local = await createEnv({ name: 'local' });
    expect(local.body.allowAiExecute).toBe(true);
    expect(local.body.allowAutoSubmit).toBe(true);

    const prodOverride = await createEnv({ name: 'production', allowAiExecute: true });
    expect(prodOverride.body.allowAiExecute).toBe(true);

    const actions = (await db.select().from(auditLogs)).map((e) => e.action);
    expect(actions).toContain('environment.created');
  });

  it('rejects a defaultEnvironmentId from another project on PATCH, accepts a valid one', async () => {
    const otherProject = (await createProject(ownerToken, { name: 'Portal', key: 'PORTAL' })).body.id;
    const foreignEnv = await request(app)
      .post(`/api/workspaces/${workspaceId}/projects/${otherProject}/environments`)
      .set(auth(ownerToken))
      .send({ name: 'staging' });

    const bad = await request(app)
      .patch(`/api/workspaces/${workspaceId}/projects/${projectId}`)
      .set(auth(ownerToken))
      .send({ defaultEnvironmentId: foreignEnv.body.id });
    expect(bad.status).toBe(400);

    const ownEnv = await createEnv({ name: 'staging' });
    const good = await request(app)
      .patch(`/api/workspaces/${workspaceId}/projects/${projectId}`)
      .set(auth(ownerToken))
      .send({ defaultEnvironmentId: ownEnv.body.id });
    expect(good.status).toBe(200);
    expect(good.body.defaultEnvironmentId).toBe(ownEnv.body.id);
  });
});

describe('URL → environment resolution', () => {
  it('matches the longest baseUrl, and returns null when nothing matches', async () => {
    const projectId = (await createProject(ownerToken, { name: 'ERP', key: 'ERP' })).body.id;
    const envUrl = (name: string, baseUrl: string) =>
      request(app)
        .post(`/api/workspaces/${workspaceId}/projects/${projectId}/environments`)
        .set(auth(ownerToken))
        .send({ name, baseUrl });
    await envUrl('staging', 'https://staging.example.com');
    const specific = await envUrl('custom', 'https://staging.example.com/orders');

    const resolve = (url: string) =>
      request(app)
        .get(`/api/workspaces/${workspaceId}/resolve`)
        .query({ url })
        .set(auth(ownerToken));

    const match = await resolve('https://staging.example.com/orders/create');
    expect(match.status).toBe(200);
    expect(match.body.match.environment.id).toBe(specific.body.id); // longest baseUrl wins

    const none = await resolve('https://unknown.example.org/');
    expect(none.body.match).toBeNull();
  });
});

describe('layered provider resolution (project → workspace)', () => {
  function mockFetch() {
    const fn = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '# Bug' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    }));
    vi.stubGlobal('fetch', fn);
    return fn;
  }
  function bugReport(body: Record<string, unknown>) {
    return request(app)
      .post(`/api/workspaces/${workspaceId}/ai/tasks/generate-bug-report`)
      .set(auth(ownerToken))
      .send({ session: { id: 's', status: 'stopped', events: [] }, ...body });
  }

  it('prefers the project default, falls back to workspace default, and again when disabled', async () => {
    const providerA = await createProvider('Workspace default'); // workspace default
    const providerB = await createProvider('Project default'); // project default
    await request(app)
      .post(`/api/workspaces/${workspaceId}/llm-providers/${providerA}/set-default`)
      .set(auth(ownerToken));
    const projectId = (
      await createProject(ownerToken, { name: 'ERP', key: 'ERP', defaultLlmProviderConfigId: providerB })
    ).body.id;

    mockFetch();
    await bugReport({ projectId });
    await bugReport({}); // no project → workspace default

    // Disable the project default; resolution falls back to the workspace default.
    await request(app)
      .patch(`/api/workspaces/${workspaceId}/llm-providers/${providerB}`)
      .set(auth(ownerToken))
      .send({ enabled: false });
    await bugReport({ projectId });

    const runs = await db.select().from(aiTaskRuns);
    expect(runs[0]!.llmProviderConfigId).toBe(providerB); // project default used
    expect(runs[0]!.projectId).toBe(projectId);
    expect(runs[1]!.llmProviderConfigId).toBe(providerA); // workspace default
    expect(runs[2]!.llmProviderConfigId).toBe(providerA); // fell back after disable
  });
});
