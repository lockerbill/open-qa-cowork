/**
 * Guard layer (auto-test-mode-spec §9): an ordered-check pipeline vetting
 * every action between decision and execution — first hit wins.
 *
 * Active checks: (1) origin lock for `navigate` targets (M2), (2) mode gate
 * for `observe_only` (§9.2, pulled forward from M4 so M3's real-model
 * acceptance cannot mutate the app). Still to land in M4: (3) destructive-
 * action policy, (4) credential hygiene / vault, (5) loop detection. Budgets
 * (6) are checked by the run controller at the top of every iteration (§7.2)
 * because exhaustion finalizes the run rather than refusing one action.
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

/**
 * A click is read-only-ish navigation (§9.2 carve-out) when the element
 * metadata shows role link/tab (an `<a>` tag is an implicit link) or carries
 * aria-expanded (surfaced as the expanded/collapsed states and allowlisted
 * attribute). Unknown elements are NOT clickable in observe-only.
 */
function isReadOnlyNavClick(element: ObservedElement | undefined): boolean {
  if (!element) return false;
  if (element.role === 'link' || element.role === 'tab') return true;
  if (element.tag === 'a') return true;
  if ('aria-expanded' in element.attributes) return true;
  return element.states.includes('expanded') || element.states.includes('collapsed');
}

/**
 * Check 2 — mode gate (§9.2): in observe_only only scroll/wait/assert/
 * report_defect/finish/press-Escape execute, plus clicks on link/tab/
 * aria-expanded elements; everything else is refused 'observe-only mode'.
 */
const modeGate: GuardCheck = (action, elements, config) => {
  if (config.mode !== 'observe_only') return null;
  switch (action.type) {
    case 'scroll':
    case 'wait':
    case 'assert':
    case 'report_defect':
    case 'finish':
      return null;
    case 'press':
      return action.key === 'Escape' ? null : { verdict: 'refuse', reason: 'observe-only mode' };
    case 'click': {
      const element = elements.find((e) => e.index === action.index);
      return isReadOnlyNavClick(element)
        ? null
        : { verdict: 'refuse', reason: 'observe-only mode' };
    }
    default:
      return { verdict: 'refuse', reason: 'observe-only mode' };
  }
};

/** Ordered pipeline (§9). M4 inserts destructive policy, vault, loop detection. */
const CHECKS: GuardCheck[] = [originLock, modeGate];

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
