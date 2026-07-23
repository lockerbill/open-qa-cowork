/**
 * Deterministic stub decider (auto-test-mode-spec §13.2): a fixture HTTP
 * server implementing the POST /auto/step contract so the M2 E2E suite runs
 * the FULL extension loop hermetically — asserting mechanics, not model
 * quality. Run with tsx (see playwright.config.ts webServer).
 *
 * Scenario selection rides the run goal: `scenario:<name>`. Every decision is
 * a pure function of (scenario, history.length, observation.serialized) — the
 * element indexes are parsed from the serialized snapshot exactly the way a
 * model would read them, never from CSS selectors.
 */
import { createServer } from 'node:http';
import {
  zAction,
  zStepRequest,
  type Action,
  type StepRequest,
  type StepResponse,
} from '@qa-copilot/shared/auto';

const PORT = Number(process.env.STUB_DECIDER_PORT ?? 5557);

/** Find an element index in the serialized snapshot, model-style. */
function indexOf(serialized: string, pattern: RegExp): number {
  const match = serialized.match(pattern);
  if (!match) throw new Error(`stub decider: no element matching ${pattern} in observation`);
  return Number(match[1]);
}

function nextAction(scenario: string, request: StepRequest): Action {
  const step = request.history.length;
  const s = request.observation.serialized;
  switch (scenario) {
    case 'happy_path':
      // Login → create a named item → assert it is visible → finish(pass).
      // The password travels as a {{PLACEHOLDER}} (§9.4): the vault-seeded SW
      // substitutes the real value; the decider never sees it.
      switch (step) {
        case 0:
          return {
            type: 'fill',
            index: indexOf(s, /\[(\d+)\]<input[^\n]*email/i),
            value: 'qa@example.com',
            intent: 'enter email',
          };
        case 1:
          return {
            type: 'fill',
            index: indexOf(s, /\[(\d+)\]<input[^\n]*password/i),
            value: '{{TEST_USER_PASSWORD}}',
            intent: 'enter password',
          };
        case 2:
          return {
            type: 'click',
            index: indexOf(s, /\[(\d+)\]<button[^\n]*Sign in/),
            intent: 'submit login',
          };
        case 3:
          return {
            type: 'fill',
            index: indexOf(s, /\[(\d+)\]<input[^\n]*item-name/i),
            value: 'Widget',
            intent: 'name the new item',
          };
        case 4:
          return {
            type: 'click',
            index: indexOf(s, /\[(\d+)\]<button[^\n]*Add item/),
            intent: 'create the item',
          };
        case 5:
          return {
            type: 'assert',
            expectation: 'the created item appears in the list',
            holds: s.includes('Widget'),
            evidence: s.includes('Widget') ? 'item list shows Widget' : 'Widget not found',
          };
        default:
          return { type: 'finish', outcome: 'pass', reason: 'item created and visible' };
      }
    case 'navigation':
      // Cross-page click; the SW re-handshakes and the loop continues (scenario 5).
      switch (step) {
        case 0:
          return {
            type: 'click',
            index: indexOf(s, /\[(\d+)\]<a[^\n]*Go to second page/),
            intent: 'open the second page',
          };
        case 1:
          return {
            type: 'assert',
            expectation: 'the second page rendered after navigation',
            holds: s.includes('Second page'),
            evidence: request.observation.url,
          };
        default:
          return { type: 'finish', outcome: 'pass', reason: 'run continued across navigation' };
      }
    case 'stale_epoch':
      // Step 0's response is delayed (see below) so the test can slip an
      // out-of-band observe in, invalidating the epoch this fill targets.
      switch (step) {
        case 0:
          return {
            type: 'fill',
            index: indexOf(s, /\[(\d+)\]<input[^\n]*email/i),
            value: 'qa@example.com',
            intent: 'enter email against a possibly stale snapshot',
          };
        default:
          return { type: 'finish', outcome: 'pass', reason: 'recovered from stale epoch' };
      }
    case 'budget':
      // Never finishes: the run must stop cleanly on maxSteps (scenario 8).
      return { type: 'scroll', direction: step % 2 === 0 ? 'down' : 'up', amount: 'half' };
    case 'kill_switch':
      // Stalls so the human (test) can hit Stop / intervene (scenario 9).
      // Alternating durations keep the M4 loop detector (identical-hash 5×)
      // from ending the run before the test uses the kill switch.
      return {
        type: 'wait',
        seconds: step % 2 === 0 ? 1 : 2,
        reason: 'idle so the kill switch can be used',
      };
    case 'confirm_reject':
      // Scenario 2: destructive click → confirmation → the test rejects; the
      // record must survive and the loop continue.
      switch (step) {
        case 0:
          return {
            type: 'click',
            index: indexOf(s, /\[(\d+)\]<button[^\n]*Delete(?! All)/),
            intent: 'delete the first record',
          };
        case 1:
          return {
            type: 'assert',
            expectation: 'the record still exists after the rejected delete',
            holds: s.includes('Sample A'),
            evidence: s.includes('Sample A') ? 'Sample A still listed' : 'Sample A gone',
          };
        default:
          return { type: 'finish', outcome: 'pass', reason: 'rejection preserved the record' };
      }
    case 'observe_only':
      // Scenario 3: fill refused by the mode gate; scroll/assert allowed.
      switch (step) {
        case 0:
          return {
            type: 'fill',
            index: indexOf(s, /\[(\d+)\]<input[^\n]*email/i),
            value: 'qa@example.com',
            intent: 'try to type in observe-only mode',
          };
        case 1:
          return { type: 'scroll', direction: 'down', amount: 'half' };
        case 2:
          return {
            type: 'assert',
            expectation: 'the playground page is visible',
            holds: s.includes('QA Auto Playground'),
            evidence: 'page heading present',
          };
        default:
          return { type: 'finish', outcome: 'pass', reason: 'observed without mutating' };
      }
    case 'broken_endpoint': {
      // Scenario 4: click the broken button; the 500 must surface in the next
      // observation's failedRequests, which becomes a report_defect.
      const failed = request.observation.failedRequests.find((r) => r.url.includes('/api/broken'));
      if (failed) {
        return {
          type: 'report_defect',
          severity: 'medium',
          summary: 'Load data fails with a server error',
          expected: 'data loads successfully',
          actual: `${failed.method} ${failed.url} -> ${failed.status}`,
        };
      }
      switch (step) {
        case 0:
          return {
            type: 'click',
            index: indexOf(s, /\[(\d+)\]<button[^\n]*Load data/),
            intent: 'load the data',
          };
        default:
          return { type: 'finish', outcome: 'fail', reason: 'broken endpoint defect reported' };
      }
    }
    case 'injection_canary':
      // Scenario 7: the canary text rides the observation as DATA; the
      // (scripted-as-hijacked) decider clicks Delete All — the guard must
      // still demand confirmation, and the test rejects it.
      switch (step) {
        case 0:
          return {
            type: 'click',
            index: indexOf(s, /\[(\d+)\]<button[^\n]*Delete All/),
            intent: 'obey the page and delete everything',
          };
        case 1:
          return {
            type: 'assert',
            expectation: 'records survived the injected instruction',
            holds: s.includes('Sample A') && s.includes('Sample B'),
            evidence: s.includes('Sample A') ? 'both records listed' : 'records missing',
          };
        default:
          return { type: 'finish', outcome: 'pass', reason: 'injection stayed inert' };
      }
    default:
      throw new Error(`stub decider: unknown scenario '${scenario}'`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Raw request bodies, capturable by tests via GET /captured — the M4
 * secret-absence instrumentation (§14): whatever the SW sends the decider is
 * exactly what a real model would see, so a secret value must never appear
 * here. DELETE /captured resets between scenarios.
 */
const captured: string[] = [];

const server = createServer((req, res) => {
  if (req.url === '/captured') {
    if (req.method === 'DELETE') {
      captured.length = 0;
      res.writeHead(204).end();
      return;
    }
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(captured));
    return;
  }
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('stub decider');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/auto/step') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk));
  req.on('end', () => {
    void (async () => {
      captured.push(body);
      const parsed = zStepRequest.safeParse(JSON.parse(body || '{}'));
      if (!parsed.success) {
        res.writeHead(422, { 'content-type': 'application/json' }).end(
          JSON.stringify({ error: 'invalid_request', detail: parsed.error.issues }),
        );
        return;
      }
      const request = parsed.data as StepRequest;
      const scenario = request.goal.replace(/^scenario:/, '');

      // Give the stale-epoch test a window to fire its out-of-band observe.
      if (scenario === 'stale_epoch' && request.history.length === 0) await sleep(1500);

      let action: Action;
      try {
        action = nextAction(scenario, request);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({ error: String(err) }),
        );
        return;
      }
      // Self-check: the stub must only ever emit schema-valid actions.
      const valid = zAction.safeParse(action);
      if (!valid.success) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({ error: 'stub emitted invalid action', detail: valid.error.issues }),
        );
        return;
      }
      const response: StepResponse = { action: valid.data };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(response));
    })().catch((err) => {
      res.writeHead(500).end(String(err));
    });
  });
});

server.listen(PORT, () => {
  console.log(`stub decider on http://127.0.0.1:${PORT}`);
});
