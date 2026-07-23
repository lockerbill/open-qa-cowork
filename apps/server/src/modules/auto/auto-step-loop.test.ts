/**
 * Task 20.1 — full-stack integration: the extension's REAL RunController loop
 * driving the REAL POST /auto/step route (auth, RBAC, provider resolution,
 * prompt assembly, validation), backed by a scripted fake provider. Asserts a
 * correction turn recovers (invalid → valid action) through the whole stack.
 *
 * The controller sources are imported straight from apps/extension — they are
 * chrome-free by design (all effects arrive via RunControllerDeps), so the
 * decide dep here POSTs to the Express app via supertest exactly the way
 * wiring.ts does over fetch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type {
  Action,
  Observation,
  ObservedElement,
  RunConfig,
} from '@qa-copilot/shared/auto';
import { createApp } from '../../app.js';
import { createTestDb } from '../../db/testing.js';
import { createLogger } from '../../logging/logger.js';
import type { Database } from '../../db/client.js';
import type { CompleteOptions, LLMProvider } from '../../llm/index.js';
import {
  DeciderValidationError,
  RunController,
  type RunControllerDeps,
} from '../../../../extension/src/background/auto/run-controller.js';
import type {
  AutoStateMsg,
  PersistedAutoRun,
} from '../../../../extension/src/background/auto/messages.js';

class MockProvider implements LLMProvider {
  readonly name = 'mock';
  async complete(_opts: CompleteOptions): Promise<string> {
    return '';
  }
  async chat(): Promise<string> {
    return '';
  }
}

const JWT = 'test-secret';
const MASTER_KEY = Buffer.alloc(32, 3).toString('base64');
const silent = createLogger('error', { write() {} });
const ORIGIN = 'http://localhost:5555';

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
    .send({ email: 'loop-owner@example.com', password: 'password123' });
  ownerToken = reg.body.token;
  workspaceId = reg.body.workspace.id;
  const created = await request(app)
    .post(`/api/workspaces/${workspaceId}/llm-providers`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      displayName: 'Scripted LLM',
      baseUrl: 'https://llm.example/v1',
      modelName: 'scripted-model',
      apiKey: 'sk-test-key',
    });
  await request(app)
    .post(`/api/workspaces/${workspaceId}/llm-providers/${created.body.id}/set-default`)
    .set('Authorization', `Bearer ${ownerToken}`);
});
afterEach(async () => {
  await close();
  vi.unstubAllGlobals();
});

/** Scripted fake provider: one canned tool-call response per LLM call. */
function scriptProvider(responses: { name: string; arguments: string }[][]) {
  const calls: { body: Record<string, unknown> }[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      calls.push({ body: JSON.parse(init.body) as Record<string, unknown> });
      const script = responses[Math.min(i, responses.length - 1)]!;
      i += 1;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { tool_calls: script.map((c) => ({ function: c })) } }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        }),
      };
    }),
  );
  return calls;
}

function makeObservation(epoch: number): Observation {
  return {
    url: `${ORIGIN}/auto-playground.html`,
    title: 'Playground',
    pageInfo: {
      viewportWidth: 1280,
      viewportHeight: 800,
      pageWidth: 1280,
      pageHeight: 800,
      pixelsAbove: 0,
      pixelsBelow: 0,
      scrollPositionPct: 0,
    },
    activeDialog: null,
    serialized: '[0]<a >Item details />',
    elementCount: 1,
    consoleErrors: [],
    failedRequests: [],
    navigationOccurred: false,
    timestamp: 1700000000000,
    epoch,
  };
}

const ELEMENTS: ObservedElement[] = [
  { index: 0, tag: 'a', role: 'link', text: 'Item details', attributes: {}, states: [], isSecret: false },
];

describe('extension loop against the real /auto/step (task 20.1)', () => {
  it('recovers from an invalid provider action via a correction turn through the full stack', async () => {
    const providerCalls = scriptProvider([
      // Call 1: click with NO index → server 422 → SW correction turn.
      [{ name: 'click', arguments: '{"intent":"open the details link"}' }],
      // Call 2 (correction re-POST): valid click on the link.
      [{ name: 'click', arguments: '{"index":0,"intent":"open the details link"}' }],
      // Call 3: finish.
      [{ name: 'finish', arguments: '{"outcome":"pass","reason":"explored"}' }],
    ]);

    const states: AutoStateMsg[] = [];
    let observeCount = 0;
    const deps: RunControllerDeps = {
      observe: async () => {
        observeCount += 1;
        return { ok: true, observation: makeObservation(observeCount), elements: ELEMENTS };
      },
      execute: async (_tabId, _runId, _epoch, _action: Action) => ({
        ok: true,
        settled: true,
        navigated: false,
        durableSelector: "getByRole('link', { name: 'Item details' })",
        elementText: 'Item details',
      }),
      showOverlay: async () => {},
      hideOverlay: async () => {},
      injectContentScript: async () => true,
      // The real endpoint, called the way wiring.ts calls it (§18.3 contract).
      decide: async (_baseUrl, stepRequest) => {
        const res = await request(app)
          .post(`/api/workspaces/${workspaceId}/auto/step`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .send(stepRequest);
        if (res.status === 422) {
          throw new DeciderValidationError((res.body.detail as string) ?? 'invalid action');
        }
        if (res.status !== 200) throw new Error(`decider HTTP ${res.status}`);
        return res.body;
      },
      getTabUrl: async () => `${ORIGIN}/auto-playground.html`,
      waitForTabLoad: async () => {},
      startRecordingSession: async () => 'session_integration',
      stopRecordingSession: async () => {},
      readVault: async () => ({}),
      saveRunResult: async () => {},
      persist: async (_state: PersistedAutoRun) => {},
      pushState: (state) => {
        states.push(JSON.parse(JSON.stringify(state)) as AutoStateMsg);
      },
      log: () => {},
      now: () => Date.now(),
      sleep: async () => {},
    };

    const controller = new RunController(deps);
    const config: RunConfig = {
      goal: 'explore the playground and verify the item details link works',
      mode: 'observe_only',
      maxSteps: 10,
      maxWallClockMs: 60_000,
      maxLlmCalls: 20,
      originAllowlist: [ORIGIN],
    };
    await controller.start(config, 1);

    const final = await vi.waitFor(
      () => {
        const last = states[states.length - 1];
        if (!last || last.status !== 'finished') throw new Error(`status ${last?.status}`);
        return last;
      },
      { timeout: 15_000 },
    );

    // The correction recovered: the click executed and the run finished.
    expect(final.outcome).toBe('pass');
    expect(final.budgets.correctionTurns).toBe(1);
    expect(final.budgets.llmCalls).toBe(3);
    expect(final.budgets.stepsUsed).toBe(2);
    expect(final.trace[0]).toMatchObject({
      action: { type: 'click', index: 0 },
      result: 'ok',
      durableSelector: "getByRole('link', { name: 'Item details' })",
    });

    // The correction note traveled through the real prompt assembly.
    expect(providerCalls).toHaveLength(3);
    const correctionUser = (providerCalls[1]!.body.messages as { content: string }[])[1]!.content;
    expect(correctionUser).toContain('your previous output was invalid');
    expect(correctionUser).toContain('index');
    // The first and second requests carried the same observation epoch (same
    // StepRequest re-POSTed), and the third a fresh one.
    const epochOf = (call: { body: Record<string, unknown> }) => {
      const user = (call.body.messages as { content: string }[])[1]!.content;
      return user;
    };
    expect(epochOf(providerCalls[0]!)).toContain('<steps_remaining>10</steps_remaining>');
    expect(epochOf(providerCalls[1]!)).toContain('<steps_remaining>10</steps_remaining>');
    expect(epochOf(providerCalls[2]!)).toContain('<steps_remaining>9</steps_remaining>');
  }, 30_000);
});
