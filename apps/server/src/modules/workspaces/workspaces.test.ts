import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { createTestDb } from '../../db/testing.js';
import { createLogger } from '../../logging/logger.js';
import { auditLogs } from '../../db/schema.js';
import type { Database } from '../../db/client.js';
import type { CompleteOptions, LLMProvider } from '../../llm/index.js';

class MockProvider implements LLMProvider {
  readonly name = 'mock';
  async complete(_opts: CompleteOptions): Promise<string> {
    return '';
  }
}

const JWT = 'test-secret';
const MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
const silent = createLogger('error', { write() {} });

let db: Database;
let close: () => Promise<void>;
let app: Express;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  app = createApp(new MockProvider(), silent, {
    db,
    jwtSecret: JWT,
    masterEncryptionKey: MASTER_KEY,
    allowPrivateLlmHosts: true,
  });
});
afterEach(async () => {
  await close();
});

function register(email: string) {
  return request(app).post('/api/auth/register').send({ email, password: 'password123' });
}

/** Register an owner (with personal workspace) and a second user to be invited. */
async function setupInvite(role = 'tester') {
  const owner = await register('ws-owner@example.com');
  const ownerToken = owner.body.token as string;
  const workspaceId = owner.body.workspace.id as string;

  const invitee = await register('ws-invitee@example.com');
  const inviteeToken = invitee.body.token as string;

  const invite = await request(app)
    .post(`/api/workspaces/${workspaceId}/members/invite`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ email: 'ws-invitee@example.com', role });
  return { ownerToken, workspaceId, inviteeToken, invite };
}

describe('workspace create + list', () => {
  it('creates a workspace and lists it as an active owner membership', async () => {
    const reg = await register('create@example.com');
    const token = reg.body.token as string;

    const created = await request(app)
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Team QA' });
    expect(created.status).toBe(201);

    const list = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    // personal workspace (from register) + the new one
    const team = list.body.workspaces.find((w: { name: string }) => w.name === 'Team QA');
    expect(team).toBeTruthy();
    expect(team.role).toBe('owner');
    expect(team.status).toBe('active');
  });
});

describe('member invite', () => {
  it('creates an invited membership for an existing user', async () => {
    const { invite } = await setupInvite();
    expect(invite.status).toBe(201);
    expect(invite.body.status).toBe('invited');
    expect(invite.body.role).toBe('tester');
  });

  it('returns 404 when inviting an email that is not registered', async () => {
    const owner = await register('o2@example.com');
    const res = await request(app)
      .post(`/api/workspaces/${owner.body.workspace.id}/members/invite`)
      .set('Authorization', `Bearer ${owner.body.token}`)
      .send({ email: 'nobody@example.com', role: 'tester' });
    expect(res.status).toBe(404);
  });

  it('returns 409 when the user is already a member', async () => {
    const { ownerToken, workspaceId } = await setupInvite();
    const dupe = await request(app)
      .post(`/api/workspaces/${workspaceId}/members/invite`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'ws-invitee@example.com', role: 'tester' });
    expect(dupe.status).toBe(409);
  });
});

describe('invited-member enforcement', () => {
  it('lists the workspace as invited but blocks guarded access until accepted', async () => {
    const { workspaceId, inviteeToken } = await setupInvite();

    const list = await request(app)
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${inviteeToken}`);
    const pending = list.body.workspaces.find((w: { id: string }) => w.id === workspaceId);
    expect(pending.status).toBe('invited');

    // a guarded resource (requireMember) is blocked with 403
    const guarded = await request(app)
      .get(`/api/workspaces/${workspaceId}`)
      .set('Authorization', `Bearer ${inviteeToken}`);
    expect(guarded.status).toBe(403);
  });

  it('accept moves the membership to active and unlocks guarded access', async () => {
    const { workspaceId, inviteeToken } = await setupInvite();

    const accept = await request(app)
      .post(`/api/workspaces/${workspaceId}/members/accept`)
      .set('Authorization', `Bearer ${inviteeToken}`);
    expect(accept.status).toBe(200);
    expect(accept.body.status).toBe('active');

    const guarded = await request(app)
      .get(`/api/workspaces/${workspaceId}`)
      .set('Authorization', `Bearer ${inviteeToken}`);
    expect(guarded.status).toBe(200);

    const actions = (await db.select().from(auditLogs)).map((e) => e.action);
    expect(actions).toContain('member.accepted');
  });

  it('decline removes the membership so the user can be re-invited', async () => {
    const { ownerToken, workspaceId, inviteeToken } = await setupInvite();

    const decline = await request(app)
      .post(`/api/workspaces/${workspaceId}/members/decline`)
      .set('Authorization', `Bearer ${inviteeToken}`);
    expect(decline.status).toBe(204);

    // membership gone — workspace no longer listed for the invitee
    const list = await request(app)
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${inviteeToken}`);
    expect(list.body.workspaces.find((w: { id: string }) => w.id === workspaceId)).toBeUndefined();

    const actions = (await db.select().from(auditLogs)).map((e) => e.action);
    expect(actions).toContain('member.declined');

    // re-invite succeeds (no 409)
    const reinvite = await request(app)
      .post(`/api/workspaces/${workspaceId}/members/invite`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'ws-invitee@example.com', role: 'tester' });
    expect(reinvite.status).toBe(201);
  });

  it('rejects accept/decline when there is no pending invite', async () => {
    const owner = await register('o3@example.com');
    const workspaceId = owner.body.workspace.id as string;
    const ownerToken = owner.body.token as string;

    // owner is already active, not invited → 409
    const accept = await request(app)
      .post(`/api/workspaces/${workspaceId}/members/accept`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(accept.status).toBe(409);

    // a stranger has no membership → 404
    const stranger = await register('o3-stranger@example.com');
    const decline = await request(app)
      .post(`/api/workspaces/${workspaceId}/members/decline`)
      .set('Authorization', `Bearer ${stranger.body.token}`);
    expect(decline.status).toBe(404);
  });
});
