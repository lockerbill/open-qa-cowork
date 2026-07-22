/**
 * Guard layer scaffold (auto-test-mode-spec §9): an ordered-check pipeline
 * vetting every action between decision and execution — first hit wins.
 *
 * M2 activates only the origin lock for `navigate` targets. The remaining
 * checks land in M4 in this order: (2) mode gate, (3) destructive-action
 * policy, (4) credential hygiene / vault, (5) loop detection. Budgets (6) are
 * checked by the run controller at the top of every iteration (§7.2) because
 * exhaustion finalizes the run rather than refusing one action.
 *
 * Every refusal is recorded by the controller as HistoryEntry{result:'refused'}
 * with the reason visible to the model, and consumes a step.
 */
import type { Action, ObservedElement, RunConfig } from '@qa-copilot/shared/auto';

export type GuardVerdict =
  | { verdict: 'allow' }
  | { verdict: 'confirm'; reason: string }
  | { verdict: 'refuse'; reason: string };

type GuardCheck = (
  action: Action,
  elements: ObservedElement[],
  config: RunConfig,
) => GuardVerdict | null;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** True when `url`'s origin is in the run's allowlist (§9.1). */
export function isOriginAllowed(url: string, config: RunConfig): boolean {
  const origin = originOf(url);
  if (!origin) return false;
  return config.originAllowlist.some((entry) => originOf(entry) === origin);
}

/** Check 1 — origin lock: `navigate` targets must stay inside the allowlist. */
const originLock: GuardCheck = (action, _elements, config) => {
  if (action.type !== 'navigate') return null;
  if (isOriginAllowed(action.url, config)) return null;
  return { verdict: 'refuse', reason: 'navigation outside allowed origin' };
};

/** Ordered pipeline (§9). M4 inserts mode gate, destructive policy, vault, loop detection. */
const CHECKS: GuardCheck[] = [originLock];

export function checkAction(
  action: Action,
  elements: ObservedElement[],
  config: RunConfig,
): GuardVerdict {
  for (const check of CHECKS) {
    const hit = check(action, elements, config);
    if (hit) return hit;
  }
  return { verdict: 'allow' };
}
