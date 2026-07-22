/**
 * Auto-mode content-script types (auto-test-mode-spec §6.1).
 *
 * `VendorApi` is a structural mirror of the vendored page-agent surface:
 * only page-driver.ts may import from vendor/page-agent (lint-enforced), so
 * every other auto module receives these functions by injection — which also
 * makes them jsdom-testable with fakes.
 */
import type { Action, Observation, ObservedElement } from '@qa-copilot/shared/auto';

export interface ActionResult {
  ok: boolean;
  reason?:
    | 'stale_epoch'
    | 'index_not_found'
    | 'element_detached'
    | 'not_visible'
    | 'covered'
    | 'not_editable'
    | 'option_not_found'
    | 'timeout'
    | 'navigation_interrupted'
    | 'error';
  detail?: string;
  durableSelector?: string;
  elementText?: string;
  settled: boolean;
  navigated: boolean;
}

export interface PageDriver {
  observe(opts?: { fresh?: boolean }): Promise<{ observation: Observation; elements: ObservedElement[] }>;
  execute(action: Action, epoch: number): Promise<ActionResult>;
  showStopOverlay(onStop: () => void, onIntervene?: () => void): void;
  hideStopOverlay(): void;
  dispose(): void;
}

/** Structural mirror of the vendored TreeNodeView (dom.ts redaction seam). */
export interface RedactableTreeNode {
  type: 'text' | 'element';
  parent: RedactableTreeNode | null;
  children: RedactableTreeNode[];
  isVisible: boolean;
  // Text node properties
  text?: string;
  // Element node properties
  tagName?: string;
  attributes?: Record<string, string>;
  isInteractive?: boolean;
  isTopElement?: boolean;
  isNew?: boolean;
  highlightIndex?: number;
  extra?: Record<string, any>;
}

/** Structural mirror of the vendored InteractiveElementDomNode (what getSelectorMap yields). */
export interface VendorSelectorNode {
  tagName: string;
  highlightIndex: number;
  attributes?: Record<string, string>;
  isNew?: boolean;
  /** Live DOM reference. */
  ref: HTMLElement;
}

/** Snake_case scroll/viewport metrics from the vendored getPageInfo. */
export interface VendorPageInfo {
  viewport_width: number;
  viewport_height: number;
  page_width: number;
  page_height: number;
  pixels_above: number;
  pixels_below: number;
  current_page_position: number;
}

export interface VendorApi {
  patchReact(): void;
  getPageInfo(): VendorPageInfo;
  getFlatTree(config: {
    viewportExpansion?: number;
    interactiveBlacklist?: Element[];
    debugHighlights?: boolean;
  }): unknown;
  getSelectorMap(flatTree: unknown): Map<number, VendorSelectorNode>;
  flatTreeToString(
    flatTree: unknown,
    includeAttributes: string[],
    keepSemanticTags: boolean,
    opts: { redactNode?: (node: RedactableTreeNode) => RedactableTreeNode },
  ): string;
  clickElement(element: HTMLElement): Promise<void>;
  inputTextElement(element: HTMLElement, text: string): Promise<void>;
  selectOptionElement(selectElement: HTMLSelectElement, optionText: string): Promise<void>;
  scrollIntoViewIfNeeded(element: Element): Promise<void>;
  scrollVertically(amountPx: number): Promise<string>;
}
