import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import type { CompleteOptions, LLMProvider } from './llm/index.js';

class MockProvider implements LLMProvider {
  readonly name = 'mock';
  lastUser = '';
  response = '';
  calls = 0;
  async complete(opts: CompleteOptions): Promise<string> {
    this.calls += 1;
    this.lastUser = opts.user;
    return this.response;
  }
}

const pageModel = {
  summary: {
    url: 'http://localhost/orders/create',
    route: '/orders/create',
    title: 'Create Purchase Order',
    headings: ['Create Purchase Order'],
    forms: [],
    buttons: ['Submit'],
    links: [],
    tables: [],
    modals: [],
    validationMessages: [],
    consoleErrors: [],
    networkFailures: [],
  },
  elements: [],
  capturedAt: '2026-06-27T10:00:00Z',
};

const session = {
  id: 'session_1',
  status: 'stopped',
  baseUrl: 'http://localhost/orders/create',
  currentUrl: 'http://localhost/orders/create',
  events: [
    {
      id: 'e1',
      sessionId: 'session_1',
      type: 'click',
      targetLabel: 'Submit',
      selectorCandidates: ["getByRole('button', { name: 'Submit' })"],
      timestamp: '2026-06-27T10:01:00Z',
      resultSummary: 'Release date is required',
    },
    {
      id: 'e2',
      sessionId: 'session_1',
      type: 'click',
      targetLabel: 'Row',
      selectorCandidates: ["locator('.row-3')"],
      timestamp: '2026-06-27T10:02:00Z',
    },
  ],
  evidence: [],
  consoleErrors: [],
  networkFailures: [],
};

let provider: MockProvider;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  provider = new MockProvider();
  app = createApp(provider);
});

describe('GET /health', () => {
  it('reports the provider', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, provider: 'mock' });
  });
});

describe('POST /api/page/analyze', () => {
  it('returns parsed JSON suggestions', async () => {
    provider.response =
      '{"summary":"A PO page","risks":["required fields"],"suggestedTests":["submit empty"]}';
    const res = await request(app).post('/api/page/analyze').send({ pageModel });
    expect(res.status).toBe(200);
    expect(res.body.summary).toBe('A PO page');
    expect(res.body.suggestedTests).toContain('submit empty');
  });

  it('tolerates fenced JSON', async () => {
    provider.response = '```json\n{"summary":"ok","risks":[],"suggestedTests":[]}\n```';
    const res = await request(app).post('/api/page/analyze').send({ pageModel });
    expect(res.body.summary).toBe('ok');
  });

  it('does not leak truncated/invalid JSON into the summary', async () => {
    // Simulates a local model cut off mid-JSON (finish_reason=length).
    provider.response = '{"summary":"A PO page","risks":["required fiel';
    const res = await request(app).post('/api/page/analyze').send({ pageModel });
    expect(res.status).toBe(200);
    expect(res.body.summary).not.toContain('{');
    expect(res.body.summary).toMatch(/malformed or truncated JSON/);
    expect(res.body.risks).toEqual([]);
    expect(res.body.suggestedTests).toEqual([]);
  });

  it('rejects an invalid body with 400', async () => {
    const res = await request(app).post('/api/page/analyze').send({ nope: true });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/generate/test-cases', () => {
  it('returns markdown with an artifact id', async () => {
    provider.response = '# Test Cases\n- TC1 ...';
    const res = await request(app)
      .post('/api/generate/test-cases')
      .send({ pageModel, focus: 'functional' });
    expect(res.status).toBe(200);
    expect(res.body.format).toBe('markdown');
    expect(res.body.artifactId).toMatch(/^artifact_/);
    expect(res.body.content).toContain('Test Cases');
  });

  it('redacts emails before they reach the LLM (defense in depth)', async () => {
    provider.response = 'ok';
    const leaky = structuredClone(pageModel);
    leaky.summary.headings = ['contact admin@secret.example.com'];
    await request(app).post('/api/generate/test-cases').send({ pageModel: leaky });
    expect(provider.lastUser).not.toContain('admin@secret.example.com');
    expect(provider.lastUser).toContain('[EMAIL]');
  });
});

describe('POST /api/generate/bug-report', () => {
  it('returns a markdown bug report', async () => {
    provider.response = '# Bug: Release date required';
    const res = await request(app)
      .post('/api/generate/bug-report')
      .send({ session, pageModel, userNote: 'Expected default date' });
    expect(res.status).toBe(200);
    expect(res.body.content).toContain('Bug');
    expect(provider.lastUser).toContain('Expected default date');
  });
});

describe('POST /api/generate/playwright', () => {
  it('is deterministic and does not call the LLM without enrich', async () => {
    const res = await request(app).post('/api/generate/playwright').send({ session });
    expect(res.status).toBe(200);
    expect(provider.calls).toBe(0);
    expect(res.body.content).toContain("import { test, expect } from '@playwright/test';");
    expect(res.body.content).toContain("getByRole('button', { name: 'Submit' }).click();");
    expect(res.body.filename).toMatch(/\.spec\.ts$/);
  });

  it('flags fragile selectors', async () => {
    const res = await request(app).post('/api/generate/playwright').send({ session });
    expect(res.body.selectorWarnings.length).toBeGreaterThanOrEqual(1);
  });

  it('enriches via the LLM when requested', async () => {
    provider.response = "import { test, expect } from '@playwright/test';\n// enriched";
    const res = await request(app)
      .post('/api/generate/playwright')
      .send({ session, enrich: true });
    expect(provider.calls).toBe(1);
    expect(res.body.content).toContain('enriched');
  });
});
