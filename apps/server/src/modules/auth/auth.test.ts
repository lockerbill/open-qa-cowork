import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { createTestDb } from '../../db/testing.js';
import { createLogger } from '../../logging/logger.js';
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

function register(email: string, displayName?: string) {
  return request(app).post('/api/auth/register').send({ email, password: 'password123', displayName });
}

describe('auth + workspace lifecycle', () => {
  it('registers a user, issues a token, and creates a personal owner workspace', async () => {
    const res = await register('owner@example.com', 'Owner');
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.email).toBe('owner@example.com');
    expect(res.body.workspace.role).toBe('owner');
  });

  it('rejects duplicate email registration', async () => {
    await register('dupe@example.com');
    const res = await register('dupe@example.com');
    expect(res.status).toBe(409);
  });

  it('logs in and returns the current user from /me', async () => {
    await register('login@example.com');
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login@example.com', password: 'password123' });
    expect(login.status).toBe(200);
    const token = login.body.token as string;

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('login@example.com');
  });

  it('rejects bad credentials', async () => {
    await register('pw@example.com');
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'pw@example.com', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('lists the caller’s workspaces with their role', async () => {
    const reg = await register('list@example.com');
    const token = reg.body.token as string;
    const res = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.workspaces).toHaveLength(1);
    expect(res.body.workspaces[0].role).toBe('owner');
  });

  it('returns 401 on a protected route without a token', async () => {
    const res = await request(app).get('/api/workspaces');
    expect(res.status).toBe(401);
  });
});

describe('RBAC enforcement', () => {
  it('forbids a tester from inviting members (owner/admin only)', async () => {
    const ownerReg = await register('a-owner@example.com');
    const wsId = ownerReg.body.workspace.id as string;

    const testerReg = await register('a-tester@example.com');
    const testerId = testerReg.body.user.id as string;
    const testerToken = testerReg.body.token as string;
    await addMember(db, { workspaceId: wsId, userId: testerId, role: 'tester' });

    // tester can read the workspace…
    const read = await request(app)
      .get(`/api/workspaces/${wsId}`)
      .set('Authorization', `Bearer ${testerToken}`);
    expect(read.status).toBe(200);

    // …but cannot invite
    const invite = await request(app)
      .post(`/api/workspaces/${wsId}/members/invite`)
      .set('Authorization', `Bearer ${testerToken}`)
      .send({ email: 'someone@example.com', role: 'tester' });
    expect(invite.status).toBe(403);
  });

  it('blocks cross-workspace access (non-members get 404)', async () => {
    const ownerReg = await register('b-owner@example.com');
    const wsId = ownerReg.body.workspace.id as string;

    const strangerReg = await register('b-stranger@example.com');
    const strangerToken = strangerReg.body.token as string;

    const res = await request(app)
      .get(`/api/workspaces/${wsId}`)
      .set('Authorization', `Bearer ${strangerToken}`);
    expect(res.status).toBe(404);
  });
});
