/**
 * Decider client (§8 contract): POST /auto/step with a per-call timeout. With
 * a `deciderBaseUrl` override the SW POSTs {base}/auto/step unauthenticated —
 * E2E points this at the stub decider (§13.2). Otherwise it targets the real
 * workspace-scoped endpoint the same way the extension calls the ai-tasks
 * gateway: bearer token + workspace path + project/environment context for
 * layered provider resolution.
 */
import type { StepRequest, StepResponse } from '@qa-copilot/shared/auto';
import { getAuth, getSettings } from '../../shared/storage.js';
import { DeciderValidationError } from './run-controller.js';

/**
 * Client-side ceiling on one /auto/step POST. The server aborts its own LLM
 * call at 60 s (AUTO_STEP_TIMEOUT_MS in apps/server/src/modules/auto/
 * routes.ts — keep the two in sight of each other); 120 s covers that plus
 * queueing/network for slow eval models while guaranteeing a hung provider
 * can never wedge the run loop: the abort surfaces as a transport error, so a
 * pending stop/pause takes effect at the loop's next control point.
 */
export const DECIDE_TIMEOUT_MS = 120_000;

/** Shared /auto/step response handling: 422 → correction turn (§8.5). */
async function readStepResponse(res: Response): Promise<StepResponse> {
  if (res.status === 422) {
    const payload = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new DeciderValidationError(payload.detail ?? 'invalid action');
  }
  if (!res.ok) throw new Error(`decider HTTP ${res.status}`);
  return (await res.json()) as StepResponse;
}

/** fetch with the decide timeout; aborts become labeled transport errors. */
async function postStep(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(DECIDE_TIMEOUT_MS) });
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`decider request timed out after ${DECIDE_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

export async function decide(baseUrl: string, request: StepRequest): Promise<StepResponse> {
  if (baseUrl) {
    const res = await postStep(`${baseUrl.replace(/\/+$/, '')}/auto/step`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    return readStepResponse(res);
  }

  const [settings, auth] = await Promise.all([getSettings(), getAuth()]);
  if (!auth.token || !auth.currentWorkspaceId) {
    throw new Error('auto mode requires a signed-in workspace (or a deciderBaseUrl override)');
  }
  const base = settings.backendUrl.replace(/\/+$/, '');
  const body = {
    ...request,
    ...(auth.currentProjectId ? { projectId: auth.currentProjectId } : {}),
    ...(auth.currentEnvironmentId ? { environmentId: auth.currentEnvironmentId } : {}),
  };
  const res = await postStep(`${base}/api/workspaces/${auth.currentWorkspaceId}/auto/step`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` },
    body: JSON.stringify(body),
  });
  return readStepResponse(res);
}
