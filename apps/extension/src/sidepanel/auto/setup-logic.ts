/**
 * Pure setup-view logic for the Auto tab (auto-test-mode-spec §10):
 * start-gating, origin parsing, RunConfig assembly, and the "use a suggested
 * test case" picker's parsing/formatting. Chrome-free and React-free so the
 * unit tests cover it directly.
 */
import type { RunConfig, RunMode } from '@qa-copilot/shared/auto';
import { RUN_DEFAULTS } from '@qa-copilot/shared/auto';

export interface SetupState {
  goal: string;
  mode: RunMode;
  /** The extra "I understand" checkbox gating Autonomous mode (§10). */
  ackAutonomous: boolean;
  maxSteps: number;
  origins: string[];
}

/** Why Start is disabled, or null when the run may begin. */
export function startBlocker(state: SetupState): string | null {
  if (!state.goal.trim()) return 'Enter a goal first.';
  if (state.origins.length === 0) return 'Add at least one allowed origin.';
  if (state.mode === 'autonomous' && !state.ackAutonomous) {
    return 'Autonomous mode requires checking “I understand”.';
  }
  return null;
}

/** One origin per line; invalid URLs are dropped, duplicates collapsed. */
export function parseOrigins(text: string): string[] {
  const origins: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      origins.push(new URL(trimmed).origin);
    } catch {
      // Not a URL — skip; the textarea keeps the raw text for the user to fix.
    }
  }
  return [...new Set(origins)];
}

export function buildRunConfig(state: SetupState, deciderBaseUrl?: string): RunConfig {
  return {
    goal: state.goal.trim(),
    mode: state.mode,
    maxSteps: state.maxSteps,
    maxWallClockMs: RUN_DEFAULTS.maxWallClockMs,
    maxLlmCalls: state.maxSteps + 10,
    originAllowlist: state.origins,
    ...(deciderBaseUrl?.trim() && { deciderBaseUrl: deciderBaseUrl.trim() }),
  };
}

// --- "Use a suggested test case" picker (§10) --------------------------------

export interface SuggestedCase {
  title: string;
  steps?: string[];
  expected?: string;
}

/**
 * §10 prefill format: `Test: <title>. Steps: <numbered steps>. Expected:
 * <expectations>` — expectations become natural `assert` targets for the run.
 */
export function formatSuggestedGoal(c: SuggestedCase): string {
  const parts = [`Test: ${c.title.replace(/[.\s]+$/, '')}.`];
  if (c.steps && c.steps.length > 0) {
    parts.push(`Steps: ${c.steps.map((s, i) => `${i + 1}. ${s.replace(/[.\s]+$/, '')}.`).join(' ')}`);
  }
  if (c.expected) parts.push(`Expected: ${c.expected.replace(/[.\s]+$/, '')}.`);
  return parts.join(' ');
}

/**
 * Field labels the test-case prompt asks for; they delimit Steps/Expected.
 * The colon is mandatory (so a step like `- Type the password` is not read as
 * a `Type` field) and may sit inside or outside the bold markers.
 */
const FIELD_LABEL =
  /^\s*(?:[-*]\s*)?\*{0,2}(ID|Title|Preconditions?|Steps|Expected(?:\s+Results?)?|Test Data|Priority|Risk|Type)\*{0,2}\s*:\s*\*{0,2}\s*(.*)$/i;

/**
 * Best-effort parse of suggest-mode "Generate test cases" markdown into
 * structured cases. The output format is LLM-authored (testCasesSystem asks
 * for ID/Title/Preconditions/Steps/Expected Result/… per case, grouped by
 * area), so this is deliberately tolerant: a case starts at any heading whose
 * text carries a TC id or at any `Title:` field; Steps/Expected are captured
 * from their labelled sections. Unparseable input yields [].
 */
export function parseTestCasesMarkdown(markdown: string): SuggestedCase[] {
  const cases: SuggestedCase[] = [];
  let current: SuggestedCase | null = null;
  /** Which labelled list section we are inside ('steps' collects items). */
  let section: 'steps' | 'expected' | 'other' = 'other';

  const push = () => {
    if (current?.title) cases.push(current);
    current = null;
  };

  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();

    const heading = line.match(/^#{2,5}\s+(.*)$/);
    if (heading) {
      const text = heading[1]!.replace(/\*+/g, '').trim();
      const tc = text.match(/^(?:TC[-_ ]?\d+|Test case\s*\d+)\s*[:.\-—]?\s*(.*)$/i);
      if (tc) {
        push();
        current = { title: tc[1]!.trim() || text };
        section = 'other';
      } else {
        // Area/grouping heading — ends any open case.
        push();
        section = 'other';
      }
      continue;
    }

    const field = line.match(FIELD_LABEL);
    if (field) {
      const label = field[1]!.toLowerCase();
      const rest = field[2]!.trim();
      if (label === 'id' && !current) current = { title: '' };
      if (label === 'title') {
        if (!current || current.title) push();
        current = current ?? { title: '' };
        current.title = rest;
        section = 'other';
        continue;
      }
      if (!current) continue;
      if (label === 'steps') {
        section = 'steps';
        if (rest) current.steps = [...(current.steps ?? []), rest];
      } else if (label.startsWith('expected')) {
        section = 'expected';
        if (rest) current.expected = rest;
      } else {
        section = 'other';
      }
      continue;
    }

    if (!current) continue;
    const item = line.match(/^\s*(?:\d+[.)]|[-*])\s+(.*)$/);
    if (item && section === 'steps') {
      current.steps = [...(current.steps ?? []), item[1]!.trim()];
    } else if (section === 'expected' && line.trim()) {
      current.expected = [current.expected, item ? item[1]!.trim() : line.trim()]
        .filter(Boolean)
        .join(' ');
    }
  }
  push();
  return cases;
}

/**
 * Picker source (§10): structured cases parsed from the last generated
 * test-cases markdown, falling back to the Page tab's one-line suggestions
 * (title-only cases → the degenerate `Test: <title>.` prefill).
 */
export function deriveSuggestedCases(
  testCasesMarkdown: string | null,
  suggestedTests: string[] | undefined,
): SuggestedCase[] {
  if (testCasesMarkdown) {
    const parsed = parseTestCasesMarkdown(testCasesMarkdown);
    if (parsed.length > 0) return parsed;
  }
  return (suggestedTests ?? []).map((title) => ({ title }));
}
