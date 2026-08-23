import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { eq } from 'drizzle-orm';
import { createApp } from '../../app.js';
import { createTestDb } from '../../db/testing.js';
import { createLogger } from '../../logging/logger.js';
import { llmProviderConfigs, projects, secrets, workspaces } from '../../db/schema.js';
import type { Database } from '../../db/client.js';
import type { CompleteOptions, LLMProvider } from '../../llm/index.js';
import { addMember } from '../workspaces/service.js';
import { createProject } from '../projects/service.js';

class MockProvider implements LLMProvider {
  readonly name = 'mock';
  async complete(_opts: CompleteOptions): Promise<string> {
    return '';
  }
}

const JWT = 'test-secret';
const MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
const API_KEY = 'sk-byo-provider-key-xyz';
const silent = createLogger('error', { write() {} });

let db: Database;
let close: () => Promise<void>;
let app: Express;
let ownerToken: string;
let workspaceId: string;

function bearer(token: string) {
  return `Bearer ${token}`;
}
const providerBody = {
  displayName: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  modelName: 'anthropic/claude-sonnet-4',
  apiKey: API_KEY,
};

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
    .send({ email: 'po-owner@example.com', password: 'password123' });
  ownerToken = reg.body.token;
  workspaceId = reg.body.workspace.id;
});
afterEach(async () => {
  await close();
  vi.unstubAllGlobals();
});

const create = () =>
  request(app)
    .post(`/api/workspaces/${workspaceId}/llm-providers`)
    .set('Authorization', bearer(ownerToken))
    .send(providerBody);

describe('LLM provider config', () => {
  it('creates a provider without ever returning the API key, and stores it encrypted', async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body.validationStatus).toBe('unknown');
    expect(JSON.stringify(res.body)).not.toContain(API_KEY);

    const rows = await db.select().from(secrets).where(eq(secrets.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.encryptedValue).not.toContain(API_KEY);
  });

  it('lets a tester list providers (no key) but forbids creating one', async () => {
    await create();
    const testerReg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'po-tester@example.com', password: 'password123' });
    await addMember(db, { workspaceId, userId: testerReg.body.user.id, role: 'tester' });
    const testerToken = testerReg.body.token as string;

    const list = await request(app)
      .get(`/api/workspaces/${workspaceId}/llm-providers`)
      .set('Authorization', bearer(testerToken));
    expect(list.status).toBe(200);
    expect(list.body.providers).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(API_KEY);

    const denied = await request(app)
      .post(`/api/workspaces/${workspaceId}/llm-providers`)
      .set('Authorization', bearer(testerToken))
      .send(providerBody);
    expect(denied.status).toBe(403);
  });

  it('validates connectivity against the provider (mocked) and persists the status', async () => {
    const created = await create();
    const id = created.body.id as string;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"ok": true}' } }] }),
      })),
    );

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/llm-providers/${id}/validate`)
      .set('Authorization', bearer(ownerToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('valid');

    const list = await request(app)
      .get(`/api/workspaces/${workspaceId}/llm-providers`)
      .set('Authorization', bearer(ownerToken));
    expect(list.body.providers[0].validationStatus).toBe('valid');
  });

  it('reports invalid without leaking the raw provider error body', async () => {
    const created = await create();
    const id = created.body.id as string;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => 'sensitive provider body: bad key sk-leak',
      })),
    );
    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/llm-providers/${id}/validate`)
      .set('Authorization', bearer(ownerToken));
    expect(res.body.status).toBe('invalid');
    expect(JSON.stringify(res.body)).not.toContain('sk-leak');
  });

  it('sets a workspace default provider', async () => {
    const created = await create();
    const id = created.body.id as string;
    const setDefault = await request(app)
      .post(`/api/workspaces/${workspaceId}/llm-providers/${id}/set-default`)
      .set('Authorization', bearer(ownerToken));
    expect(setDefault.status).toBe(200);

    const list = await request(app)
      .get(`/api/workspaces/${workspaceId}/llm-providers`)
      .set('Authorization', bearer(ownerToken));
    expect(list.body.providers[0].isWorkspaceDefault).toBe(true);
  });

  it('rejects a private/SSRF base URL when private hosts are disallowed', async () => {
    const guarded = createApp(new MockProvider(), silent, {
      db,
      jwtSecret: JWT,
      masterEncryptionKey: MASTER_KEY,
      allowPrivateLlmHosts: false,
    });
    const res = await request(guarded)
      .post(`/api/workspaces/${workspaceId}/llm-providers`)
      .set('Authorization', bearer(ownerToken))
      .send({ ...providerBody, baseUrl: 'https://169.254.169.254/v1' });
    expect(res.status).toBe(400);
  });

  it('lists providers in a stable creation order and marks the chosen default', async () => {
    const first = (await create()).body.id as string;
    const second = (
      await request(app)
        .post(`/api/workspaces/${workspaceId}/llm-providers`)
        .set('Authorization', bearer(ownerToken))
        .send({ ...providerBody, displayName: 'Second' })
    ).body.id as string;

    await request(app)
      .post(`/api/workspaces/${workspaceId}/llm-providers/${second}/set-default`)
      .set('Authorization', bearer(ownerToken));
    // Touch the first row after the second was defaulted — order must not change.
    await request(app)
      .patch(`/api/workspaces/${workspaceId}/llm-providers/${first}`)
      .set('Authorization', bearer(ownerToken))
      .send({ displayName: 'First (renamed)' });

    const list = await request(app)
      .get(`/api/workspaces/${workspaceId}/llm-providers`)
      .set('Authorization', bearer(ownerToken));
    expect(list.body.providers.map((p: { id: string }) => p.id)).toEqual([first, second]);
    expect(list.body.providers.map((p: { isWorkspaceDefault: boolean }) => p.isWorkspaceDefault)).toEqual([
      false,
      true,
    ]);
  });

  it('refuses to set a disabled provider as the workspace default', async () => {
    const id = (await create()).body.id as string;
    const disabled = await request(app)
      .patch(`/api/workspaces/${workspaceId}/llm-providers/${id}`)
      .set('Authorization', bearer(ownerToken))
      .send({ enabled: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.enabled).toBe(false);

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/llm-providers/${id}/set-default`)
      .set('Authorization', bearer(ownerToken));
    expect(res.status).toBe(409);
  });

  it('updates fields and reports isWorkspaceDefault on the PATCH response', async () => {
    const id = (await create()).body.id as string;
    await request(app)
      .post(`/api/workspaces/${workspaceId}/llm-providers/${id}/set-default`)
      .set('Authorization', bearer(ownerToken));

    const res = await request(app)
      .patch(`/api/workspaces/${workspaceId}/llm-providers/${id}`)
      .set('Authorization', bearer(ownerToken))
      .send({ displayName: 'Renamed', modelName: 'openai/gpt-4o-mini' });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('Renamed');
    expect(res.body.modelName).toBe('openai/gpt-4o-mini');
    expect(res.body.isWorkspaceDefault).toBe(true);
  });

  it('rotates the API key without returning it', async () => {
    const id = (await create()).body.id as string;
    const [before] = await db.select().from(secrets).where(eq(secrets.workspaceId, workspaceId));

    const res = await request(app)
      .post(`/api/workspaces/${workspaceId}/llm-providers/${id}/rotate-secret`)
      .set('Authorization', bearer(ownerToken))
      .send({ apiKey: 'sk-new-key-123' });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('sk-new-key-123');

    const [after] = await db.select().from(secrets).where(eq(secrets.workspaceId, workspaceId));
    expect(after!.encryptedValue).not.toBe(before!.encryptedValue);
    expect(after!.encryptedValue).not.toContain('sk-new-key-123');
    expect(after!.rotatedAt).not.toBeNull();
  });

  it('deletes a provider, its secret, and clears workspace/project default pointers', async () => {
    const id = (await create()).body.id as string;
    await request(app)
      .post(`/api/workspaces/${workspaceId}/llm-providers/${id}/set-default`)
      .set('Authorization', bearer(ownerToken));
    const me = await request(app).get('/api/auth/me').set('Authorization', bearer(ownerToken));
    const project = await createProject(db, {
      workspaceId,
      actorUserId: me.body.user.id,
      name: 'ERP',
      key: 'ERP',
      defaultLlmProviderConfigId: id,
    });

    const res = await request(app)
      .delete(`/api/workspaces/${workspaceId}/llm-providers/${id}`)
      .set('Authorization', bearer(ownerToken));
    expect(res.status).toBe(204);

    expect(await db.select().from(llmProviderConfigs)).toHaveLength(0);
    expect(await db.select().from(secrets).where(eq(secrets.workspaceId, workspaceId))).toHaveLength(0);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(ws!.defaultLlmProviderConfigId).toBeNull();
    const [proj] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(proj!.defaultLlmProviderConfigId).toBeNull();

    const list = await request(app)
      .get(`/api/workspaces/${workspaceId}/llm-providers`)
      .set('Authorization', bearer(ownerToken));
    expect(list.body.providers).toHaveLength(0);
  });

  it('forbids a tester from editing or deleting a provider', async () => {
    const id = (await create()).body.id as string;
    const testerReg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'po-tester2@example.com', password: 'password123' });
    await addMember(db, { workspaceId, userId: testerReg.body.user.id, role: 'tester' });
    const testerToken = testerReg.body.token as string;

    const patch = await request(app)
      .patch(`/api/workspaces/${workspaceId}/llm-providers/${id}`)
      .set('Authorization', bearer(testerToken))
      .send({ displayName: 'nope' });
    expect(patch.status).toBe(403);
    const del = await request(app)
      .delete(`/api/workspaces/${workspaceId}/llm-providers/${id}`)
      .set('Authorization', bearer(testerToken));
    expect(del.status).toBe(403);
  });

  it('blocks cross-workspace provider access', async () => {
    const created = await create();
    const id = created.body.id as string;

    const otherReg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'other-owner@example.com', password: 'password123' });
    const otherToken = otherReg.body.token as string;
    const otherWs = otherReg.body.workspace.id as string;

    const res = await request(app)
      .post(`/api/workspaces/${otherWs}/llm-providers/${id}/validate`)
      .set('Authorization', bearer(otherToken));
    expect(res.status).toBe(404);

    const del = await request(app)
      .delete(`/api/workspaces/${otherWs}/llm-providers/${id}`)
      .set('Authorization', bearer(otherToken));
    expect(del.status).toBe(404);
  });
});
