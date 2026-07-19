/**
 * End-to-end Jira export against a mock Jira server (e2e/jira-mock.mjs).
 *
 * Drives the background service worker through its JIRA_* message contract —
 * the same path the side panel uses — so the assertions cover message handling,
 * the client, ADF conversion and the attachment multipart in one pass.
 */
import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mapReportToIssue } from '../src/integrations/jira/mapping.js';

const distPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const JIRA = 'http://127.0.0.1:5556';

const JIRA_CONFIG = {
  projectKey: 'QA',
  issueTypeId: '10004',
  priorityMap: { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' } as const,
};

interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

const REPORT_MARKDOWN = [
  '# Release date does not default from requested delivery date',
  '',
  '**Severity:** critical',
  '',
  '## Steps to Reproduce',
  '',
  '1. Open the **New Order** page',
  '2. Click `Save`',
  '',
  '## Evidence',
  '',
  '```json',
  '{ "status": 500 }',
  '```',
].join('\n');

let context: BrowserContext;
let worker: Worker;
/**
 * An extension page is required to message the worker: chrome.runtime
 * .sendMessage called inside the service worker does not reach its own
 * listener. The options page stands in for the side panel here.
 */
let panel: Page;

async function background(ctx: BrowserContext): Promise<Worker> {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker');
  return sw;
}

/** Send a message to the worker exactly as the side panel would. */
async function send<T>(message: unknown): Promise<T> {
  return panel.evaluate(async (msg) => {
    return (await chrome.runtime.sendMessage(msg)) as unknown;
  }, message) as Promise<T>;
}

async function recorded(): Promise<RecordedRequest[]> {
  const res = await fetch(`${JIRA}/__requests`);
  return (await res.json()) as RecordedRequest[];
}

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${distPath}`, `--load-extension=${distPath}`],
  });
  worker = await background(context);

  const extensionId = new URL(worker.url()).host;
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/options/index.html`);

  // 127.0.0.1 is already in host_permissions, so the permission request the
  // save handler makes resolves without a prompt.
  await fetch(`${JIRA}/__reset`);
  const saved = await send<{ ok: boolean }>({
    type: 'JIRA_SAVE_CONFIG',
    config: {
      siteUrl: JIRA,
      email: 'qa@acme.io',
      apiToken: 'tok-e2e',
      projectKey: 'QA',
      issueTypeId: '10004',
      priorityMap: { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' },
      verified: false,
    },
  });
  expect(saved.ok).toBe(true);
});

test.afterAll(async () => {
  await context?.close();
});

test('connection test authenticates against /myself and persists the config', async () => {
  const calls = await recorded();
  const myself = calls.find((c) => c.path === '/rest/api/3/myself');

  expect(myself).toBeTruthy();
  expect(myself!.headers.authorization).toMatch(/^Basic /);
  // The token must be base64-encoded, never sent in the clear.
  expect(myself!.headers.authorization).not.toContain('tok-e2e');

  const config = await send<{ ok: boolean; data: { verified: boolean; hasToken: boolean } }>({
    type: 'JIRA_GET_CONFIG',
  });
  expect(config.data.verified).toBe(true);
  expect(config.data.hasToken).toBe(true);
  // The projection must never carry the token back to the UI.
  expect(JSON.stringify(config.data)).not.toContain('tok-e2e');
});

test('createmeta surfaces required custom fields', async () => {
  const res = await send<{ ok: boolean; data: { fieldId: string; required: boolean }[] }>({
    type: 'JIRA_GET_CREATE_META',
  });

  expect(res.ok).toBe(true);
  expect(res.data.find((f) => f.fieldId === 'customfield_101')?.required).toBe(true);
});

test('creates an issue with a valid ADF description and uploads attachments', async () => {
  await fetch(`${JIRA}/__reset`);

  // Seed a session with one screenshot so there is real evidence to attach.
  await worker.evaluate(() =>
    chrome.storage.local.set({
      session: {
        id: 's-e2e',
        startedAt: new Date().toISOString(),
        status: 'stopped',
        events: [],
        evidence: [
          {
            id: 'ev1',
            sessionId: 's-e2e',
            type: 'screenshot',
            dataUrl:
              'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
            capturedAt: new Date().toISOString(),
          },
        ],
        consoleErrors: [],
        networkFailures: [],
      },
    }),
  );

  const res = await send<{
    ok: boolean;
    data: { link: { issueKey: string; url: string }; attachments: { filename: string; ok: boolean }[] };
  }>({
    type: 'JIRA_CREATE_ISSUE',
    request: {
      artifactId: 'artifact-e2e',
      payload: mapReportToIssue(REPORT_MARKDOWN, { config: JIRA_CONFIG }),
      attachSession: true,
      playwrightSpec: { filename: 'order.spec.ts', content: "test('x', async () => {});" },
    },
  });

  expect(res.ok).toBe(true);
  expect(res.data.link.issueKey).toBe('QA-101');
  expect(res.data.link.url).toBe(`${JIRA}/browse/QA-101`);

  // screenshot + session.json + playwright spec
  expect(res.data.attachments).toHaveLength(3);
  expect(res.data.attachments.every((a) => a.ok)).toBe(true);

  const calls = await recorded();
  const create = calls.find((c) => c.path === '/rest/api/3/issue' && c.method === 'POST');
  expect(create).toBeTruthy();
  expect(create!.headers['content-type']).toContain('application/json');

  const attachments = calls.filter((c) => c.path.endsWith('/attachments'));
  expect(attachments).toHaveLength(3);
  for (const call of attachments) {
    expect(call.headers['x-atlassian-token']).toBe('no-check');
    expect(call.headers['content-type']).toContain('multipart/form-data');
    expect(call.headers['content-type']).toContain('boundary=');
    expect(call.body).toContain('Content-Disposition: form-data; name="file"');
  }
  expect(attachments.map((c) => c.body).join('\n')).toContain('order.spec.ts');
});

test('the ADF description produced from report markdown is structurally valid', async () => {
  await fetch(`${JIRA}/__reset`);

  // Built by the same production module the composer uses.
  const payload = mapReportToIssue(REPORT_MARKDOWN, { config: JIRA_CONFIG });

  const res = await send<{ ok: boolean }>({
    type: 'JIRA_CREATE_ISSUE',
    request: { artifactId: 'artifact-adf', payload, attachSession: false, playwrightSpec: null },
  });
  expect(res.ok).toBe(true);

  const calls = await recorded();
  const create = calls.find((c) => c.path === '/rest/api/3/issue' && c.method === 'POST');
  const body = JSON.parse(create!.body) as {
    fields: {
      summary: string;
      priority?: { name: string };
      labels: string[];
      description: { version: number; type: string; content: { type: string }[] };
    };
  };

  expect(body.fields.summary).toBe('Release date does not default from requested delivery date');
  expect(body.fields.summary.length).toBeLessThanOrEqual(255);
  expect(body.fields.priority).toEqual({ name: 'Highest' });
  expect(body.fields.labels).toContain('openqa');

  const description = body.fields.description;
  expect(description.version).toBe(1);
  expect(description.type).toBe('doc');

  const types = description.content.map((n) => n.type);
  expect(types).toContain('heading');
  expect(types).toContain('orderedList');
  expect(types).toContain('codeBlock');
});

test('a failed create surfaces per-field errors and stores no link', async () => {
  await fetch(`${JIRA}/__reset`);

  const res = await send<{ ok: boolean; code: string }>({
    type: 'JIRA_CREATE_ISSUE',
    request: {
      artifactId: 'artifact-missing-summary',
      payload: { fields: { project: { key: 'QA' }, issuetype: { id: '10004' }, summary: '' } },
      attachSession: false,
      playwrightSpec: null,
    },
  });

  expect(res.ok).toBe(false);
  expect(res.code).toBe('invalid_request');

  const links = await send<{ ok: boolean; data: Record<string, unknown> }>({ type: 'JIRA_GET_LINKS' });
  expect(links.data['artifact-missing-summary']).toBeUndefined();
});

test('the stored link makes the export idempotent per artifact', async () => {
  const links = await send<{ ok: boolean; data: Record<string, { issueKey: string }> }>({
    type: 'JIRA_GET_LINKS',
  });

  expect(links.data['artifact-e2e']?.issueKey).toBe('QA-101');
  expect(links.data['artifact-adf']?.issueKey).toBe('QA-101');
});
