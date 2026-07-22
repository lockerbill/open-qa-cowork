/**
 * PageDriver — the vendor boundary (auto-test-mode-spec §6.1). This is the
 * ONLY module allowed to import from vendor/page-agent (lint-enforced); it
 * assembles the `VendorApi` and injects it into the observation builder and
 * executor. Owns the current element-ref map, the epoch, and the per-step
 * capture buffers. The refId map never survives a step boundary: every
 * observe() gets fresh indices and a new epoch.
 */
import type { ActionEvent } from '@qa-copilot/shared';
import type { Action, Observation, ObservedElement } from '@qa-copilot/shared/auto';
import {
  clickElement,
  inputTextElement,
  scrollIntoViewIfNeeded,
  scrollVertically,
  selectOptionElement,
} from '../../vendor/page-agent/actions.js';
import { flatTreeToString, getFlatTree, getSelectorMap } from '../../vendor/page-agent/dom.js';
import { getPageInfo } from '../../vendor/page-agent/get-page-info.js';
import { patchReact } from '../../vendor/page-agent/patches/react.js';
import { executeAction, type RecorderMirrorEvent } from './executor.js';
import { buildObservation } from './observation-builder.js';
import { settle } from './settle.js';
import { createStepCapture } from './step-capture.js';
import { showStopOverlay, type StopOverlayHandle } from './stop-overlay.js';
import type { PageDriver, VendorApi, VendorSelectorNode } from './types.js';

export type { ActionResult, PageDriver } from './types.js';

const vendorApi: VendorApi = {
  patchReact,
  getPageInfo,
  getFlatTree: (config) => getFlatTree(config),
  getSelectorMap: (flatTree) =>
    // Structural cast: VendorSelectorNode mirrors InteractiveElementDomNode.
    getSelectorMap(flatTree as Parameters<typeof getSelectorMap>[0]) as unknown as Map<
      number,
      VendorSelectorNode
    >,
  flatTreeToString: (flatTree, includeAttributes, keepSemanticTags, opts) =>
    flatTreeToString(
      flatTree as Parameters<typeof flatTreeToString>[0],
      includeAttributes,
      keepSemanticTags,
      opts,
    ),
  clickElement,
  inputTextElement,
  selectOptionElement,
  scrollIntoViewIfNeeded,
  scrollVertically: (amountPx) => scrollVertically(amountPx).then(() => ''),
};

export interface PageDriverOptions {
  /** Completes the executor's mirror events and hands them to the recorder pipeline. */
  emitRecorderEvent: (event: ActionEvent) => void;
  /** Recorder session the run writes into. */
  sessionId: string;
  debugHighlights?: boolean;
  doc?: Document;
}

export function createPageDriver(options: PageDriverOptions): PageDriver {
  const doc = options.doc ?? document;
  const win = doc.defaultView ?? window;

  const capture = createStepCapture(win);
  capture.start();

  let epoch = 0;
  let elementRefs = new Map<number, Element>();
  let lastObservedUrl: string | null = null;
  let overlay: StopOverlayHandle | null = null;
  let eventSeq = 0;

  const emitMirror = (mirror: RecorderMirrorEvent) => {
    eventSeq += 1;
    options.emitRecorderEvent({
      ...mirror,
      id: `event_auto_${Date.now().toString(36)}_${eventSeq}`,
      sessionId: options.sessionId,
    });
  };

  return {
    async observe(): Promise<{ observation: Observation; elements: ObservedElement[] }> {
      epoch += 1;
      const drained = capture.drain();
      const bundle = buildObservation({
        vendor: vendorApi,
        epoch,
        navigationOccurred: lastObservedUrl !== null && lastObservedUrl !== win.location.href,
        consoleErrors: drained.consoleErrors,
        failedRequests: drained.failedRequests,
        debugHighlights: options.debugHighlights,
        doc,
      });
      elementRefs = bundle.elementRefs;
      lastObservedUrl = win.location.href;
      return { observation: bundle.observation, elements: bundle.elements };
    },

    execute(action: Action, actionEpoch: number) {
      return executeAction(action, actionEpoch, {
        vendor: vendorApi,
        elementRefs,
        currentEpoch: epoch,
        settle: () => settle({ inFlightRequests: capture.inFlight, doc }),
        emitRecorderEvent: emitMirror,
        ...(action.type !== 'scroll' && action.type !== 'wait' && { intent: intentOf(action) }),
        doc,
      });
    },

    showStopOverlay(onStop, onIntervene) {
      overlay?.hide();
      overlay = showStopOverlay(onStop, onIntervene, doc);
    },

    hideStopOverlay() {
      overlay?.hide();
      overlay = null;
    },

    dispose() {
      overlay?.hide();
      overlay = null;
      capture.stop();
    },
  };
}

function intentOf(action: Action): string | undefined {
  return 'intent' in action ? action.intent : undefined;
}
