/**
 * Task 15.3: tool defs cover all 10 action types with required fields;
 * zStepRequest accepts the M2 loop's real requests and rejects malformed ones.
 */
import { describe, it, expect } from 'vitest';
import { actionToolDefs } from './action.js';
import { zStepRequest, type StepRequest } from './step.js';

const ACTION_TYPES = [
  'click',
  'fill',
  'select',
  'press',
  'scroll',
  'navigate',
  'wait',
  'assert',
  'report_defect',
  'finish',
] as const;

describe('actionToolDefs (§5.2, §8.3)', () => {
  const defs = actionToolDefs();
  const byName = new Map(defs.map((d) => [d.name, d]));

  it('emits exactly one tool per action type, named after it', () => {
    expect(defs.map((d) => d.name).sort()).toEqual([...ACTION_TYPES].sort());
  });

  it('every tool has a description and an object input schema', () => {
    for (const def of defs) {
      expect(def.description.length, def.name).toBeGreaterThan(0);
      expect(def.inputSchema.type).toBe('object');
      expect(def.inputSchema.properties).toBeTypeOf('object');
    }
  });

  it('omits the type discriminator — the tool name carries it', () => {
    for (const def of defs) {
      const properties = def.inputSchema.properties as Record<string, unknown>;
      expect(Object.keys(properties), def.name).not.toContain('type');
    }
  });

  it('marks the required fields per action type', () => {
    const required = (name: string) => (byName.get(name)!.inputSchema.required as string[]).sort();
    expect(required('click')).toEqual(['index', 'intent']);
    expect(required('fill')).toEqual(['index', 'intent', 'value']);
    expect(required('select')).toEqual(['index', 'intent', 'option']);
    expect(required('press')).toEqual(['intent', 'key']);
    // amount has a default → optional for the model
    expect(required('scroll')).toEqual(['direction']);
    expect(required('navigate')).toEqual(['intent', 'url']);
    expect(required('wait')).toEqual(['reason', 'seconds']);
    expect(required('assert')).toEqual(['evidence', 'expectation', 'holds']);
    expect(required('report_defect')).toEqual(['actual', 'expected', 'severity', 'summary']);
    expect(required('finish')).toEqual(['outcome', 'reason']);
  });

  it('derives constraints from the zod objects', () => {
    const click = byName.get('click')!.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(click.index).toMatchObject({ type: 'integer', minimum: 0 });
    expect(click.intent).toMatchObject({ type: 'string', maxLength: 200 });

    const press = byName.get('press')!.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(press.key).toMatchObject({
      type: 'string',
      enum: ['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp'],
    });

    const scroll = byName.get('scroll')!.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(scroll.amount).toMatchObject({ enum: ['page', 'half'], default: 'page' });

    const wait = byName.get('wait')!.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(wait.seconds).toMatchObject({ type: 'number', minimum: 1, maximum: 8 });

    const assertProps = byName.get('assert')!.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(assertProps.holds).toMatchObject({ type: 'boolean' });
  });
});

/** A request shaped exactly like the M2 loop's stepRequest() output. */
function realStepRequest(): StepRequest {
  return {
    goal: 'explore the playground',
    mode: 'observe_only',
    history: [
      {
        step: 1,
        action: { type: 'click', index: 0, intent: 'open the form' },
        result: 'ok',
        urlAfter: 'http://localhost:5555/auto-playground.html',
        newErrors: 0,
      },
    ],
    observation: {
      url: 'http://localhost:5555/auto-playground.html',
      title: 'Playground',
      pageInfo: {
        viewportWidth: 1280,
        viewportHeight: 800,
        pageWidth: 1280,
        pageHeight: 1600,
        pixelsAbove: 0,
        pixelsBelow: 800,
        scrollPositionPct: 0,
      },
      activeDialog: null,
      serialized: '[0]<button >Create item />',
      elementCount: 1,
      consoleErrors: [],
      failedRequests: [],
      navigationOccurred: false,
      timestamp: 1700000000000,
      epoch: 2,
    },
    stepsRemaining: 24,
    placeholders: ['TEST_USER_EMAIL'],
  };
}

describe('zStepRequest (§5.3, task 15.2)', () => {
  it('accepts a real M2 loop request', () => {
    expect(zStepRequest.safeParse(realStepRequest()).success).toBe(true);
  });

  it('accepts compressed history summary lines alongside entries', () => {
    const request = realStepRequest();
    request.history.unshift({
      kind: 'summary',
      fromStep: 1,
      toStep: 5,
      line: 'steps 1–5: clicked "Add item", filled item-name (all ok)',
    });
    expect(zStepRequest.safeParse(request).success).toBe(true);
  });

  it('accepts an optional correction note (§8.5)', () => {
    const request = { ...realStepRequest(), correction: 'previous output was invalid: no index' };
    expect(zStepRequest.safeParse(request).success).toBe(true);
  });

  it('rejects a missing goal and a bad mode', () => {
    const base = realStepRequest();
    expect(zStepRequest.safeParse({ ...base, goal: '' }).success).toBe(false);
    expect(zStepRequest.safeParse({ ...base, mode: 'yolo' }).success).toBe(false);
  });

  it('tolerates recorded invalid model output in history (§8.5) but not action-less entries', () => {
    const base = realStepRequest();
    // A step that failed as model_output_invalid keeps the raw output in
    // history so the model can see its mistake; the request must still parse.
    const invalidRecorded = {
      ...base,
      history: [
        {
          ...base.history[0],
          action: { type: 'execute_js', code: 'alert(1)' },
          result: 'failed',
          resultDetail: 'model_output_invalid',
        },
      ],
    };
    expect(zStepRequest.safeParse(invalidRecorded).success).toBe(true);
    const actionless = {
      ...base,
      history: [{ ...base.history[0], action: { code: 'alert(1)' } }],
    };
    expect(zStepRequest.safeParse(actionless).success).toBe(false);
  });

  it('rejects an observation missing its serialized snapshot', () => {
    const base = realStepRequest();
    const observation = { ...base.observation } as Record<string, unknown>;
    delete observation.serialized;
    expect(zStepRequest.safeParse({ ...base, observation }).success).toBe(false);
  });
});
