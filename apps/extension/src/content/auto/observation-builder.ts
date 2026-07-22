/**
 * Builds the redacted, indexed page snapshot the LLM reads
 * (auto-test-mode-spec §6.2). Vendor functions arrive via `VendorApi`
 * injection — see types.ts for why.
 */
import type {
  Observation,
  ObservedElement,
  ObservedElementState,
  PageInfo,
} from '@qa-copilot/shared/auto';
import { redactText, REDACTED } from '@qa-copilot/shared';
import { accessibleName, fieldIsSensitive } from '../element-extract.js';
import { capText, redactTreeNode } from './redact-node.js';
import type { VendorApi, VendorSelectorNode } from './types.js';

/** page-agent's tuned extension default (§6.2.1). */
export const VIEWPORT_EXPANSION = 400;
/** Above this many interactive elements, fall back to viewport-only (§6.2.1). */
export const MAX_INTERACTIVE_ELEMENTS = 150;
const MAX_CONSOLE_ERRORS = 10;
const MAX_FAILED_REQUESTS = 10;

/** Attribute allowlist for ObservedElement metadata (§5.1). */
const ELEMENT_ATTR_ALLOWLIST = [
  'title',
  'type',
  'name',
  'role',
  'value',
  'placeholder',
  'alt',
  'aria-label',
  'aria-expanded',
  'aria-checked',
  'href',
  'id',
  'for',
];

export interface ObservationBuilderDeps {
  vendor: VendorApi;
  epoch: number;
  navigationOccurred: boolean;
  /** Drained per-step buffers (§6.5), already redacted by step-capture. */
  consoleErrors: string[];
  failedRequests: Array<{ method: string; url: string; status: number }>;
  debugHighlights?: boolean;
  doc?: Document;
}

export interface ObservationBundle {
  observation: Observation;
  elements: ObservedElement[];
  /** Live refs by index — kept in the driver for the executor; never serialized. */
  elementRefs: Map<number, Element>;
}

function visibleDialogName(doc: Document): string | null {
  const dialogs = Array.from(
    doc.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]'),
  ).filter((d) => {
    const rect = d.getBoundingClientRect();
    const style = d.ownerDocument.defaultView?.getComputedStyle(d);
    return rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden';
  });
  const top = dialogs[dialogs.length - 1];
  if (!top) return null;
  const name =
    accessibleName(top) ?? top.querySelector('h1, h2, h3, h4')?.textContent?.trim() ?? 'dialog';
  return capText(redactText(name));
}

function statesOf(el: Element, node: VendorSelectorNode): ObservedElementState[] {
  const states: ObservedElementState[] = [];
  const aria = (name: string) => el.getAttribute(name);
  if ((el as HTMLInputElement).disabled === true || aria('aria-disabled') === 'true') states.push('disabled');
  if ((el as HTMLInputElement).checked === true || aria('aria-checked') === 'true') states.push('checked');
  if (aria('aria-expanded') === 'true') states.push('expanded');
  if (aria('aria-expanded') === 'false') states.push('collapsed');
  if (aria('aria-invalid') === 'true') states.push('invalid');
  if ((el as HTMLInputElement).required === true || aria('aria-required') === 'true') states.push('required');
  if ((el as HTMLInputElement).readOnly === true || aria('aria-readonly') === 'true') states.push('readonly');
  if (node.isNew) states.push('new');
  return states;
}

function toObservedElement(index: number, node: VendorSelectorNode): ObservedElement {
  const el = node.ref;
  // isSecret means "fill only via placeholder" (§5.1) — only fillable
  // elements qualify; a <label for="password"> must not inherit the flag.
  const tag = node.tagName.toLowerCase();
  const fillable = tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  const isSecret = fillable && fieldIsSensitive(el);
  const rawText = accessibleName(el) ?? el.textContent?.trim() ?? '';
  const attributes: Record<string, string> = {};
  const sourceAttrs = node.attributes ?? {};
  for (const key of ELEMENT_ATTR_ALLOWLIST) {
    const value = sourceAttrs[key];
    if (value === undefined || value === '') continue;
    attributes[key] = isSecret && key === 'value' ? REDACTED : capText(redactText(value));
  }
  return {
    index,
    tag,
    role: el.getAttribute('role') ?? undefined,
    text: capText(redactText(rawText)),
    attributes,
    states: statesOf(el, node),
    isSecret,
  };
}

export function buildObservation(deps: ObservationBuilderDeps): ObservationBundle {
  const doc = deps.doc ?? document;
  const win = doc.defaultView ?? window;
  const { vendor } = deps;

  // React roots claim whole-page interactivity without this (§6.2.1).
  vendor.patchReact();

  // patchReact marks roots with data-page-agent-not-interactive; upstream's
  // (un-vendored) PageController feeds those into the blacklist — so do we.
  // [data-openqa-ignore] is belt & braces: dom_tree also skips those subtrees.
  const blacklist = Array.from(
    doc.querySelectorAll('[data-openqa-ignore], [data-page-agent-not-interactive]'),
  );

  let flatTree = vendor.getFlatTree({
    viewportExpansion: VIEWPORT_EXPANSION,
    interactiveBlacklist: blacklist,
    debugHighlights: deps.debugHighlights,
  });
  let selectorMap = vendor.getSelectorMap(flatTree);
  let truncated = false;
  if (selectorMap.size > MAX_INTERACTIVE_ELEMENTS) {
    truncated = true;
    flatTree = vendor.getFlatTree({
      viewportExpansion: 0,
      interactiveBlacklist: blacklist,
      debugHighlights: deps.debugHighlights,
    });
    selectorMap = vendor.getSelectorMap(flatTree);
  }

  const body = vendor.flatTreeToString(flatTree, [], false, { redactNode: redactTreeNode });

  const p = vendor.getPageInfo();
  const pageInfo: PageInfo = {
    viewportWidth: p.viewport_width,
    viewportHeight: p.viewport_height,
    pageWidth: p.page_width,
    pageHeight: p.page_height,
    pixelsAbove: p.pixels_above,
    pixelsBelow: p.pixels_below,
    scrollPositionPct: Math.round(Math.min(1, Math.max(0, p.current_page_position)) * 100),
  };

  const activeDialog = visibleDialogName(doc);

  // Header/footer ported from page-agent's getBrowserState format (§6.2.4).
  const lines: string[] = [];
  lines.push(`Current Page: [${doc.title}](${win.location.href})`);
  lines.push(
    `Page info: ${pageInfo.viewportWidth}x${pageInfo.viewportHeight}px viewport, ` +
      `${pageInfo.pageWidth}x${pageInfo.pageHeight}px total page size, ` +
      `at ${pageInfo.scrollPositionPct}% of page`,
  );
  if (activeDialog) {
    lines.push(`⚠ A dialog "${activeDialog}" is open. Elements outside it may be inert.`);
  }
  lines.push(
    pageInfo.pixelsAbove > 0
      ? `... ${pageInfo.pixelsAbove} pixels above - scroll up to see more ...`
      : '[Start of page]',
  );
  lines.push(body);
  lines.push(
    pageInfo.pixelsBelow > 0
      ? `... ${pageInfo.pixelsBelow} pixels below - scroll down to see more ...`
      : '[End of page]',
  );
  if (truncated) {
    lines.push(
      `[Note: more than ${MAX_INTERACTIVE_ELEMENTS} interactive elements found; ` +
        `only the current viewport is indexed. Scroll to reveal more.]`,
    );
  }

  const elements: ObservedElement[] = [];
  const elementRefs = new Map<number, Element>();
  for (const [index, node] of selectorMap) {
    elements.push(toObservedElement(index, node));
    elementRefs.set(index, node.ref);
  }
  elements.sort((a, b) => a.index - b.index);

  const observation: Observation = {
    url: win.location.href,
    title: doc.title,
    pageInfo,
    activeDialog,
    serialized: lines.join('\n'),
    elementCount: selectorMap.size,
    consoleErrors: deps.consoleErrors.slice(0, MAX_CONSOLE_ERRORS),
    failedRequests: deps.failedRequests.slice(0, MAX_FAILED_REQUESTS),
    navigationOccurred: deps.navigationOccurred,
    timestamp: Date.now(),
    epoch: deps.epoch,
  };

  return { observation, elements, elementRefs };
}
