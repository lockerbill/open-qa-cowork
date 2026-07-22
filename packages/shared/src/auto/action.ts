/**
 * The Action union — the complete contract between the LLM and the extension
 * (auto-test-mode-spec §5.2). The zod schemas validate provider output on the
 * server AND re-validate defensively in the service worker.
 *
 * Exactly one action per step. No free-form JS execution action exists —
 * do not add one.
 */
import { z } from 'zod';

export const zClick = z.object({
  type: z.literal('click'),
  index: z.number().int().min(0),
  /** Required on every element action. */
  intent: z.string().max(200),
});

export const zFill = z.object({
  type: z.literal('fill'),
  index: z.number().int().min(0),
  /** May contain {{PLACEHOLDER}} tokens. */
  value: z.string().max(2000),
  intent: z.string().max(200),
});

export const zSelect = z.object({
  type: z.literal('select'),
  index: z.number().int().min(0),
  /** Visible option text. */
  option: z.string().max(200),
  intent: z.string().max(200),
});

export const zPress = z.object({
  type: z.literal('press'),
  key: z.enum(['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp']),
  intent: z.string().max(200),
});

export const zScroll = z.object({
  type: z.literal('scroll'),
  direction: z.enum(['down', 'up']),
  amount: z.enum(['page', 'half']).default('page'),
});

export const zNavigate = z.object({
  type: z.literal('navigate'),
  /** Guard enforces same-origin (§9.1). */
  url: z.string().url(),
  intent: z.string().max(200),
});

export const zWait = z.object({
  type: z.literal('wait'),
  seconds: z.number().min(1).max(8),
  reason: z.string().max(200),
});

export const zAssert = z.object({
  type: z.literal('assert'),
  /** Stated in plain language. */
  expectation: z.string().max(300),
  /** Model's verdict against current observation. */
  holds: z.boolean(),
  /** What in the observation supports the verdict. */
  evidence: z.string().max(300),
});

export const zReportDefect = z.object({
  type: z.literal('report_defect'),
  severity: z.enum(['low', 'medium', 'high']),
  summary: z.string().max(300),
  expected: z.string().max(300),
  actual: z.string().max(300),
});

export const zFinish = z.object({
  type: z.literal('finish'),
  outcome: z.enum(['pass', 'fail', 'blocked']),
  reason: z.string().max(500),
});

export const zAction = z.discriminatedUnion('type', [
  zClick,
  zFill,
  zSelect,
  zPress,
  zScroll,
  zNavigate,
  zWait,
  zAssert,
  zReportDefect,
  zFinish,
]);
export type Action = z.infer<typeof zAction>;

/** A provider-facing tool definition (one per action type). */
export interface ProviderToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
}

/**
 * Tool definitions for providers that support function calling — one tool per
 * action type, names = action type. Implemented in M3 (server provider
 * adaptation, §8.3); nothing may call this before then.
 */
export function actionToolDefs(): ProviderToolDef[] {
  throw new Error('actionToolDefs() lands in M3 (auto-test-mode-spec §8.3)');
}
