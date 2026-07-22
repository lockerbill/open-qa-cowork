/**
 * Action executor with safety gates (auto-test-mode-spec §6.4). Resolution
 * order before any vendored primitive runs: epoch → index → connectedness →
 * visibility → hit test. The durable selector is recorded BEFORE dispatch —
 * the click may destroy the node. Vendor primitives arrive via `VendorApi`
 * injection (see types.ts).
 */
import type { ActionEvent } from '@qa-copilot/shared';
import type { Action } from '@qa-copilot/shared/auto';
import { fieldIsSensitive } from '../element-extract.js';
import { beginAutoDispatch, endAutoDispatch } from './auto-dispatch.js';
import { recordSelector } from './selector-recorder.js';
import type { ActionResult, VendorApi } from './types.js';

/** Scroll amounts as viewport fractions (§6.4.7). */
const SCROLL_FRACTION = { page: 0.9, half: 0.45 } as const;
const OPTION_LIST_CAP = 10;

/** What the executor emits into the session recorder pipeline (§6.4.9). */
export type RecorderMirrorEvent = Omit<ActionEvent, 'id' | 'sessionId'>;

export interface ExecutorDeps {
  vendor: VendorApi;
  /** Live refs from the current observation's selector map. */
  elementRefs: Map<number, Element>;
  /** Epoch of the observation `elementRefs` came from. */
  currentEpoch: number;
  settle: () => Promise<{ settled: boolean }>;
  emitRecorderEvent: (event: RecorderMirrorEvent) => void;
  /** The model's stated intent, forwarded into the recorder mirror. */
  intent?: string;
  doc?: Document;
}

function isElementAction(action: Action): action is Extract<Action, { index: number }> {
  return action.type === 'click' || action.type === 'fill' || action.type === 'select';
}

function describe(el: Element): string {
  const text = el.textContent?.trim().slice(0, 60) ?? '';
  return text ? `<${el.tagName.toLowerCase()}> "${text}"` : `<${el.tagName.toLowerCase()}>`;
}

function fail(reason: NonNullable<ActionResult['reason']>, detail?: string): ActionResult {
  return { ok: false, reason, ...(detail !== undefined && { detail }), settled: true, navigated: false };
}

/** Resolves once if/when the page starts unloading (hard navigation). */
function navigationSentinel(win: Window): { fired: () => boolean; promise: Promise<void>; dispose: () => void } {
  let fired = false;
  let resolveNav: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveNav = resolve;
  });
  const onPageHide = () => {
    fired = true;
    resolveNav();
  };
  win.addEventListener('pagehide', onPageHide);
  return {
    fired: () => fired,
    promise,
    dispose: () => win.removeEventListener('pagehide', onPageHide),
  };
}

export async function executeAction(
  action: Action,
  epoch: number,
  deps: ExecutorDeps,
): Promise<ActionResult> {
  // Trace-only actions never touch the page (§6.4.7).
  if (action.type === 'assert' || action.type === 'report_defect' || action.type === 'finish') {
    return { ok: true, settled: true, navigated: false };
  }

  const doc = deps.doc ?? document;
  const win = doc.defaultView ?? window;
  const nav = navigationSentinel(win);
  const urlBefore = win.location.href;

  try {
    if (isElementAction(action)) {
      return await executeElementAction(action, epoch, deps, doc, win, nav, urlBefore);
    }

    // Non-element actions: no stale-map risk, no target to gate.
    beginAutoDispatch();
    try {
      switch (action.type) {
        case 'press': {
          const target = (doc.activeElement ?? doc.body) as HTMLElement;
          const init: KeyboardEventInit = {
            key: action.key,
            code: action.key,
            bubbles: true,
            cancelable: true,
          };
          target.dispatchEvent(new KeyboardEvent('keydown', init));
          if (action.key === 'Enter') target.dispatchEvent(new KeyboardEvent('keypress', init));
          target.dispatchEvent(new KeyboardEvent('keyup', init));
          break;
        }
        case 'scroll': {
          const fraction = SCROLL_FRACTION[action.amount ?? 'page'];
          const px = Math.round(win.innerHeight * fraction) * (action.direction === 'down' ? 1 : -1);
          await deps.vendor.scrollVertically(px);
          break;
        }
        case 'wait':
          await new Promise((resolve) => setTimeout(resolve, action.seconds * 1000));
          break;
        case 'navigate':
          // Guarded by the SW (origin lock, §9.1) before it ever reaches us.
          win.location.assign(action.url);
          break;
      }
    } finally {
      endAutoDispatch();
    }

    return await settleOutcome(deps, win, nav, urlBefore);
  } finally {
    nav.dispose();
  }
}

async function executeElementAction(
  action: Extract<Action, { index: number }>,
  epoch: number,
  deps: ExecutorDeps,
  doc: Document,
  win: Window,
  nav: ReturnType<typeof navigationSentinel>,
  urlBefore: string,
): Promise<ActionResult> {
  // Gate 1: stale snapshot — never guess against a fresh page (§6.4.1).
  if (epoch !== deps.currentEpoch) {
    return fail('stale_epoch', `action epoch ${epoch}, current ${deps.currentEpoch}`);
  }
  // Gate 2: index resolution.
  const el = deps.elementRefs.get(action.index);
  if (!el) return fail('index_not_found', `no element at index ${action.index}`);
  // Gate 3: connectedness.
  if (!el.isConnected) return fail('element_detached');
  // Gate 4: visibility.
  await deps.vendor.scrollIntoViewIfNeeded(el);
  const style = win.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) {
    return fail('not_visible');
  }
  // Gate 5: hit test — a covered control is frequently the very bug the QA
  // wants to find; the covering element goes into `detail` (§6.4.5).
  const hit = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  const hitOk =
    hit !== null &&
    (hit === el || el.contains(hit) || (hit instanceof HTMLLabelElement && hit.contains(el)));
  if (!hitOk) {
    return fail('covered', hit ? `covered by ${describe(hit)}` : 'no element at target center');
  }

  // Record the durable selector NOW — dispatch may destroy the node (§6.4.6).
  const recorded = recordSelector(el);
  const sensitive = fieldIsSensitive(el);

  beginAutoDispatch();
  try {
    switch (action.type) {
      case 'click':
        await deps.vendor.clickElement(el as HTMLElement);
        break;
      case 'fill': {
        try {
          await deps.vendor.inputTextElement(el as HTMLElement, action.value);
        } catch (err) {
          return {
            ...fail('not_editable', err instanceof Error ? err.message : String(err)),
            ...recorded,
          };
        }
        const isValueField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
        if (isValueField && el.value !== action.value) {
          return { ...fail('error', 'value_not_applied'), ...recorded };
        }
        break;
      }
      case 'select': {
        if (!(el instanceof HTMLSelectElement)) {
          return { ...fail('not_editable', 'target is not a <select>'), ...recorded };
        }
        try {
          await deps.vendor.selectOptionElement(el, action.option);
        } catch {
          const options = Array.from(el.options, (o) => o.textContent?.trim() ?? '').slice(
            0,
            OPTION_LIST_CAP,
          );
          return {
            ...fail('option_not_found', `available options: ${options.join(', ')}`),
            ...recorded,
          };
        }
        break;
      }
    }
  } finally {
    endAutoDispatch();
  }

  // Mirror into the session recorder as a synthetic source:'auto' event
  // (§6.4.9); the manual recorder skipped our synthetic DOM events via the
  // auto-dispatch gate, so this is the timeline's single entry.
  const mirror: RecorderMirrorEvent = {
    type: action.type === 'fill' ? 'input' : action.type,
    timestamp: new Date().toISOString(),
    source: 'auto',
    ...(deps.intent !== undefined && { intent: deps.intent }),
    ...(recorded.elementText !== undefined && { targetLabel: recorded.elementText }),
    selectorCandidates: recorded.selectorCandidates,
  };
  if (action.type === 'fill') {
    if (sensitive) {
      mirror.valueType = 'sensitive'; // value intentionally omitted
    } else {
      mirror.value = action.value;
      mirror.valueType = 'text';
    }
  } else if (action.type === 'select') {
    mirror.value = action.option;
    mirror.valueType = 'option';
  }
  deps.emitRecorderEvent(mirror);

  const outcome = await settleOutcome(deps, win, nav, urlBefore);
  return { ...outcome, ...recorded };
}

/** Settle vs. hard-navigation race (§6.4.8): navigation is a success, not an error. */
async function settleOutcome(
  deps: ExecutorDeps,
  win: Window,
  nav: { fired: () => boolean; promise: Promise<void> },
  urlBefore: string,
): Promise<ActionResult> {
  const settled = await Promise.race([
    deps.settle(),
    nav.promise.then(() => null),
  ]);
  if (settled === null || nav.fired()) {
    return { ok: true, settled: false, navigated: true };
  }
  return {
    ok: true,
    settled: settled.settled,
    navigated: win.location.href !== urlBefore,
  };
}
