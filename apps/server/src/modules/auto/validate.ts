/**
 * Provider-output validation for POST /auto/step (auto-test-mode-spec §8.4):
 * every candidate action — from the tool path or the JSON path — funnels
 * through zAction.safeParse. Failures produce a compact human-readable issue
 * list for the 422 body, which the service worker turns into a correction turn.
 */
import { zAction, type Action } from '@qa-copilot/shared/auto';

export type ValidationOutcome =
  | { ok: true; action: Action }
  | { ok: false; detail: string };

/** Compact issue list, e.g. `type 'click': index: Required`. */
export function validateCandidate(candidate: unknown): ValidationOutcome {
  if (candidate === null || typeof candidate !== 'object') {
    return { ok: false, detail: 'model output was not a parseable JSON action object' };
  }
  const parsed = zAction.safeParse(candidate);
  if (parsed.success) return { ok: true, action: parsed.data };

  const type = (candidate as { type?: unknown }).type;
  const typeLabel = typeof type === 'string' ? `type '${type}': ` : '';
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || 'action'}: ${issue.message}`)
    .join('; ');
  return { ok: false, detail: `${typeLabel}${issues}` };
}
