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

const ACTION_SCHEMAS: Record<Action['type'], { schema: z.ZodObject<z.ZodRawShape>; description: string }> = {
  click: { schema: zClick, description: 'Click the element at [index].' },
  fill: {
    schema: zFill,
    description:
      'Type a value into the input at [index], replacing its current content. ' +
      'Use {{PLACEHOLDER}} tokens verbatim for credentials.',
  },
  select: {
    schema: zSelect,
    description: 'Choose an option of the dropdown at [index] by its visible text.',
  },
  press: { schema: zPress, description: 'Press a key on the currently focused element.' },
  scroll: { schema: zScroll, description: 'Scroll the page vertically.' },
  navigate: { schema: zNavigate, description: 'Navigate the tab to a same-origin URL.' },
  wait: { schema: zWait, description: 'Wait for the page to make progress before observing again.' },
  assert: {
    schema: zAssert,
    description:
      'Record a verdict on an expectation against the current observation. Does not touch the page.',
  },
  report_defect: {
    schema: zReportDefect,
    description: 'Report a bug you found, with expected vs actual. Does not touch the page.',
  },
  finish: {
    schema: zFinish,
    description: 'End the run with an overall outcome. Emit before the step budget runs out.',
  },
};

/**
 * Derive the JSON-Schema fragment for one zod field. Handles exactly the
 * constructs the action schemas use (number/int/min/max, string/max, enum,
 * boolean, default, optional) — extend it if a new construct is added, and the
 * tool-def unit tests will catch anything unhandled.
 */
function fieldToJsonSchema(field: z.ZodTypeAny): Record<string, unknown> {
  const def = field._def as { typeName: string };
  if (field instanceof z.ZodDefault) {
    const inner = fieldToJsonSchema(field._def.innerType as z.ZodTypeAny);
    return { ...inner, default: field._def.defaultValue() };
  }
  if (field instanceof z.ZodOptional) {
    return fieldToJsonSchema(field._def.innerType as z.ZodTypeAny);
  }
  if (field instanceof z.ZodNumber) {
    const out: Record<string, unknown> = { type: 'number' };
    for (const check of field._def.checks) {
      if (check.kind === 'int') out.type = 'integer';
      if (check.kind === 'min') out.minimum = check.value;
      if (check.kind === 'max') out.maximum = check.value;
    }
    return out;
  }
  if (field instanceof z.ZodString) {
    const out: Record<string, unknown> = { type: 'string' };
    for (const check of field._def.checks) {
      if (check.kind === 'min') out.minLength = check.value;
      if (check.kind === 'max') out.maxLength = check.value;
      if (check.kind === 'url') out.format = 'uri';
    }
    return out;
  }
  if (field instanceof z.ZodEnum) {
    return { type: 'string', enum: [...(field._def.values as string[])] };
  }
  if (field instanceof z.ZodBoolean) {
    return { type: 'boolean' };
  }
  throw new Error(`actionToolDefs: unhandled zod construct '${def.typeName}'`);
}

/**
 * Tool definitions for providers that support function calling (§8.3): one
 * tool per action type, name = the action type, parameters = JSON Schema
 * derived from the zod objects. The `type` discriminator is omitted from the
 * input schema — the tool NAME carries it; the server reconstructs the action
 * as `{ ...input, type: name }` before zAction validation.
 */
export function actionToolDefs(): ProviderToolDef[] {
  return (Object.keys(ACTION_SCHEMAS) as Action['type'][]).map((type) => {
    const { schema, description } = ACTION_SCHEMAS[type];
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, field] of Object.entries(schema.shape)) {
      if (key === 'type') continue;
      properties[key] = fieldToJsonSchema(field as z.ZodTypeAny);
      if (!(field instanceof z.ZodOptional) && !(field instanceof z.ZodDefault)) {
        required.push(key);
      }
    }
    return {
      name: type,
      description,
      inputSchema: { type: 'object', properties, required, additionalProperties: false },
    };
  });
}
