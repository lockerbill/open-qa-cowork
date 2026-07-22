import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Action } from '@qa-copilot/shared/auto';
import { executeAction, type ExecutorDeps, type RecorderMirrorEvent } from './executor.js';
import type { VendorApi } from './types.js';

/** jsdom has no layout: stub rects + hit-testing per test. */
function stubRect(el: Element, rect: Partial<DOMRect> = {}) {
  const full = { left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20, x: 0, y: 0, ...rect };
  el.getBoundingClientRect = () => ({ ...full, toJSON: () => full }) as DOMRect;
}

function hitReturns(el: Element | null) {
  (document as { elementFromPoint?: (x: number, y: number) => Element | null }).elementFromPoint =
    () => el;
}

function makeVendor(overrides: Partial<VendorApi> = {}): VendorApi {
  return {
    patchReact: vi.fn(),
    getPageInfo: vi.fn(),
    getFlatTree: vi.fn(),
    getSelectorMap: vi.fn(),
    flatTreeToString: vi.fn(),
    clickElement: vi.fn(async (el: HTMLElement) => el.click()),
    inputTextElement: vi.fn(async (el: HTMLElement, text: string) => {
      (el as HTMLInputElement).value = text;
    }),
    selectOptionElement: vi.fn(async (el: HTMLSelectElement, optionText: string) => {
      const option = Array.from(el.options).find((o) => o.textContent?.trim() === optionText);
      if (!option) throw new Error(`Option with text "${optionText}" not found in select element`);
      el.value = option.value;
    }),
    scrollIntoViewIfNeeded: vi.fn(async () => {}),
    scrollVertically: vi.fn(async () => ''),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps & { mirrors: RecorderMirrorEvent[] } {
  const mirrors: RecorderMirrorEvent[] = [];
  return {
    vendor: makeVendor(),
    elementRefs: new Map<number, Element>(),
    currentEpoch: 1,
    settle: async () => ({ settled: true }),
    emitRecorderEvent: (e) => mirrors.push(e),
    mirrors,
    ...overrides,
  };
}

const click = (index: number): Action => ({ type: 'click', index, intent: 'test click' });

describe('executeAction — safety gates (spec §6.4.1–5)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('rejects a stale epoch without touching the page', async () => {
    const deps = makeDeps({ currentEpoch: 3 });
    const result = await executeAction(click(0), 2, deps);
    expect(result).toMatchObject({ ok: false, reason: 'stale_epoch' });
    expect(deps.vendor.clickElement).not.toHaveBeenCalled();
  });

  it('rejects an unknown index', async () => {
    const result = await executeAction(click(42), 1, makeDeps());
    expect(result).toMatchObject({ ok: false, reason: 'index_not_found' });
  });

  it('rejects a detached element', async () => {
    const el = document.createElement('button');
    const result = await executeAction(click(0), 1, makeDeps({ elementRefs: new Map([[0, el]]) }));
    expect(result).toMatchObject({ ok: false, reason: 'element_detached' });
  });

  it('rejects an element with no visible box', async () => {
    const el = document.createElement('button');
    document.body.appendChild(el); // jsdom default rect is 0x0
    const result = await executeAction(click(0), 1, makeDeps({ elementRefs: new Map([[0, el]]) }));
    expect(result).toMatchObject({ ok: false, reason: 'not_visible' });
  });

  it('reports a covered element with the covering element in detail', async () => {
    const el = document.createElement('button');
    el.textContent = 'Save';
    document.body.appendChild(el);
    stubRect(el);
    const cover = document.createElement('div');
    cover.textContent = 'Cookie banner';
    document.body.appendChild(cover);
    hitReturns(cover);

    const result = await executeAction(click(0), 1, makeDeps({ elementRefs: new Map([[0, el]]) }));
    expect(result).toMatchObject({ ok: false, reason: 'covered' });
    expect(result.detail).toContain('<div>');
    expect(result.detail).toContain('Cookie banner');
  });

  it('accepts a hit on an ancestor label (label wraps the input)', async () => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    label.appendChild(input);
    document.body.appendChild(label);
    stubRect(input);
    hitReturns(label);

    const deps = makeDeps({ elementRefs: new Map([[0, input]]) });
    const result = await executeAction(
      { type: 'fill', index: 0, value: 'hello', intent: 'fill it' },
      1,
      deps,
    );
    expect(result.ok).toBe(true);
  });
});

describe('executeAction — dispatch outcomes (spec §6.4.6–9)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function visibleEl<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    document.body.appendChild(el);
    stubRect(el);
    hitReturns(el);
    return el;
  }

  it('records the durable selector before dispatch (click destroys the node)', async () => {
    const el = visibleEl('button');
    el.setAttribute('data-testid', 'self-destruct');
    el.textContent = 'Boom';
    const deps = makeDeps({
      vendor: makeVendor({ clickElement: vi.fn(async () => el.remove()) }),
      elementRefs: new Map([[0, el]]),
    });
    const result = await executeAction(click(0), 1, deps);
    expect(result.ok).toBe(true);
    expect(result.durableSelector).toBe("getByTestId('self-destruct')");
    expect(result.elementText).toBe('Boom');
  });

  it('fill verifies the applied value → value_not_applied on mismatch', async () => {
    const el = visibleEl('input');
    const deps = makeDeps({
      vendor: makeVendor({ inputTextElement: vi.fn(async () => {}) }), // never applies
      elementRefs: new Map([[0, el]]),
    });
    const result = await executeAction({ type: 'fill', index: 0, value: 'abc', intent: 'x' }, 1, deps);
    expect(result).toMatchObject({ ok: false, reason: 'error', detail: 'value_not_applied' });
  });

  it('fill on a non-editable element → not_editable', async () => {
    const el = visibleEl('div');
    const deps = makeDeps({
      vendor: makeVendor({
        inputTextElement: vi.fn(async () => {
          throw new Error('Element is not an input, textarea, or contenteditable');
        }),
      }),
      elementRefs: new Map([[0, el]]),
    });
    const result = await executeAction({ type: 'fill', index: 0, value: 'abc', intent: 'x' }, 1, deps);
    expect(result).toMatchObject({ ok: false, reason: 'not_editable' });
  });

  it('select with a missing option → option_not_found listing available options', async () => {
    const el = visibleEl('select');
    el.innerHTML = '<option>North</option><option>South</option>';
    const deps = makeDeps({ elementRefs: new Map([[0, el]]) });
    const result = await executeAction(
      { type: 'select', index: 0, option: 'West', intent: 'x' },
      1,
      deps,
    );
    expect(result).toMatchObject({ ok: false, reason: 'option_not_found' });
    expect(result.detail).toContain('North');
    expect(result.detail).toContain('South');
  });

  it('mirrors executed actions as source:auto recorder events with selectors', async () => {
    const el = visibleEl('button');
    el.setAttribute('data-testid', 'go');
    el.textContent = 'Go';
    const deps = makeDeps({ elementRefs: new Map([[0, el]]), intent: 'press go' });
    await executeAction(click(0), 1, deps);
    expect(deps.mirrors).toHaveLength(1);
    expect(deps.mirrors[0]).toMatchObject({
      type: 'click',
      source: 'auto',
      intent: 'press go',
      targetLabel: 'Go',
    });
    expect(deps.mirrors[0]?.selectorCandidates?.[0]).toBe("getByTestId('go')");
  });

  it('sensitive fill mirrors valueType:sensitive and never the value', async () => {
    const el = visibleEl('input');
    el.type = 'password';
    el.name = 'password';
    const deps = makeDeps({ elementRefs: new Map([[0, el]]) });
    const result = await executeAction(
      { type: 'fill', index: 0, value: 'hunter2', intent: 'login' },
      1,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(deps.mirrors[0]).toMatchObject({ type: 'input', valueType: 'sensitive', source: 'auto' });
    expect(deps.mirrors[0]?.value).toBeUndefined();
    expect(JSON.stringify(deps.mirrors)).not.toContain('hunter2');
  });

  it('trace-only actions return immediately without page interaction', async () => {
    const deps = makeDeps();
    const result = await executeAction(
      { type: 'assert', expectation: 'e', holds: true, evidence: 'v' },
      99, // stale epoch is irrelevant for trace-only actions
      deps,
    );
    expect(result).toEqual({ ok: true, settled: true, navigated: false });
    expect(deps.mirrors).toHaveLength(0);
  });

  it('reports navigated:true when the URL changed during the step', async () => {
    const el = visibleEl('button');
    const deps = makeDeps({
      elementRefs: new Map([[0, el]]),
      settle: async () => {
        window.history.pushState({}, '', '/next-page');
        return { settled: true };
      },
    });
    const result = await executeAction(click(0), 1, deps);
    expect(result.ok).toBe(true);
    expect(result.navigated).toBe(true);
  });
});
