/**
 * Guard layer (auto-test-mode-spec §9): an ordered-check pipeline vetting
 * every action between decision and execution — first hit wins.
 *
 * Active checks: (1) origin lock for `navigate` targets (M2), (2) mode gate
 * for `observe_only` (§9.2), (3) destructive-action policy (§9.3), and
 * (4) credential hygiene against the session vault (§9.4). Loop detection (5)
 * lives in the run controller (its input is the recorded step, including
 * urlAfter, which only exists post-execution), and budgets (6) are checked by
 * the controller at the top of every iteration (§7.2) because exhaustion
 * finalizes the run rather than refusing one action.
 *
 * Every refusal is recorded by the controller as HistoryEntry{result:'refused'}
 * with the reason visible to the model, and consumes a step.
 */
import type { Action, ObservedElement, RunConfig } from '@qa-copilot/shared/auto';
import { DEFAULT_DESTRUCTIVE_PATTERNS } from '@qa-copilot/shared/auto';

export type GuardVerdict =
  | { verdict: 'allow'; destructive?: boolean }
  | { verdict: 'confirm'; reason: string; destructive?: boolean }
  | { verdict: 'refuse'; reason: string };

interface GuardContext {
  elements: ObservedElement[];
  config: RunConfig;
  /** Available credential placeholder NAMES (§9.4); never values. */
  vaultNames: string[];
}

type GuardCheck = (action: Action, ctx: GuardContext) => GuardVerdict | null;

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
const originLock: GuardCheck = (action, { config }) => {
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
const modeGate: GuardCheck = (action, { elements, config }) => {
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

/** Text the destructive policy matches: element text + aria-label + title (§9.3). */
function destructiveMatchText(element: ObservedElement): string {
  return [element.text, element.attributes['aria-label'], element.attributes['title']]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** Per-run pattern override (serializable strings in RunConfig) or the shared defaults. */
function policyPatterns(config: RunConfig): RegExp[] {
  if (!config.destructivePatterns) return DEFAULT_DESTRUCTIVE_PATTERNS;
  return config.destructivePatterns.map((source) => new RegExp(source, 'i'));
}

/**
 * Check 3 — destructive-action policy (§9.3) for click / press Enter /
 * navigate. Matches → allow-and-tag in autonomous, require confirmation in
 * confirm. Targets the SW has no metadata for (hallucinated click index;
 * press Enter, whose focused element the SW cannot identify) are treated as
 * destructive in confirm mode and allowed untagged in autonomous. navigate is
 * matched against its URL (v1 ships no separate urlPatterns defaults).
 * observe_only is skipped: the mode gate already vetoed every mutating action.
 */
const destructivePolicy: GuardCheck = (action, { elements, config }) => {
  if (config.mode === 'observe_only') return null;
  let matchText: string | null;
  switch (action.type) {
    case 'click': {
      const element = elements.find((e) => e.index === action.index);
      matchText = element ? destructiveMatchText(element) : null;
      break;
    }
    case 'press':
      if (action.key !== 'Enter') return null;
      matchText = null; // focused element unknown to the SW
      break;
    case 'navigate':
      matchText = action.url.toLowerCase();
      break;
    default:
      return null;
  }

  if (matchText === null) {
    return config.mode === 'confirm'
      ? {
          verdict: 'confirm',
          reason: 'target element cannot be verified; treated as destructive',
        }
      : null;
  }
  if (!policyPatterns(config).some((pattern) => pattern.test(matchText))) return null;
  if (config.mode === 'autonomous') return { verdict: 'allow', destructive: true };
  return {
    verdict: 'confirm',
    reason: `matches destructive pattern: "${matchText.slice(0, 80)}"`,
    destructive: true,
  };
};

const PLACEHOLDER_RE = /\{\{([A-Za-z0-9_]+)\}\}/g;
/** The whole value is exactly one placeholder token (required on secret fields). */
const EXCLUSIVE_PLACEHOLDER_RE = /^\{\{([A-Za-z0-9_]+)\}\}$/;

function unknownPlaceholderRefusal(name: string, vaultNames: string[]): GuardVerdict {
  const available = vaultNames.length > 0 ? vaultNames.join(', ') : '(none)';
  return {
    verdict: 'refuse',
    reason: `unknown placeholder {{${name}}}; available: ${available}`,
  };
}

/**
 * Check 4 — credential hygiene (§9.4): a `fill` on an isSecret target must be
 * exclusively one known `{{PLACEHOLDER}}`; literal values are refused so a
 * model can never type (or invent) a real secret. Placeholders in non-secret
 * fills must also resolve, otherwise the token would be typed verbatim.
 */
const credentialHygiene: GuardCheck = (action, { elements, vaultNames }) => {
  if (action.type !== 'fill') return null;
  const element = elements.find((e) => e.index === action.index);
  if (element?.isSecret) {
    const exclusive = EXCLUSIVE_PLACEHOLDER_RE.exec(action.value.trim());
    if (!exclusive) return { verdict: 'refuse', reason: 'secret fields accept placeholders only' };
    if (!vaultNames.includes(exclusive[1]!)) {
      return unknownPlaceholderRefusal(exclusive[1]!, vaultNames);
    }
    return null;
  }
  for (const match of action.value.matchAll(PLACEHOLDER_RE)) {
    if (!vaultNames.includes(match[1]!)) return unknownPlaceholderRefusal(match[1]!, vaultNames);
  }
  return null;
};

/** Ordered pipeline (§9). Loop detection and budgets live in the controller. */
const CHECKS: GuardCheck[] = [originLock, modeGate, destructivePolicy, credentialHygiene];

export function checkAction(
  action: Action,
  elements: ObservedElement[],
  config: RunConfig,
  vaultNames: string[] = [],
): GuardVerdict {
  const ctx: GuardContext = { elements, config, vaultNames };
  for (const check of CHECKS) {
    const hit = check(action, ctx);
    if (hit) return hit;
  }
  return { verdict: 'allow' };
}

/**
 * Substitute vault values into a fill's `{{PLACEHOLDER}}` tokens immediately
 * before AUTO_EXECUTE (§9.4). Only the executed action carries the real value;
 * the trace, history, and every prompt keep the tokenized original. Unknown
 * tokens pass through untouched (the guard already refused them).
 */
export function substituteCredentials(action: Action, vault: Record<string, string>): Action {
  if (action.type !== 'fill') return action;
  const value = action.value.replace(PLACEHOLDER_RE, (token, name: string) => vault[name] ?? token);
  return value === action.value ? action : { ...action, value };
}
