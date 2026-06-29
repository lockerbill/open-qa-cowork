import {
  isSensitiveField,
  rankSelectors,
  selectorStrings,
  type ElementInfo,
  type ElementState,
  type ElementType,
  type SelectorInput,
} from '@qa-copilot/shared';

const IMPLICIT_ROLE: Record<string, string> = {
  a: 'link',
  button: 'button',
  select: 'combobox',
  textarea: 'textbox',
  table: 'table',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
};

/** CSS.escape with a fallback for environments (older jsdom) that lack it. */
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function implicitRole(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    return 'textbox';
  }
  return IMPLICIT_ROLE[tag];
}

export function getRole(el: Element): string | undefined {
  return el.getAttribute('role')?.trim() || implicitRole(el);
}

/** Find the <label> text associated with a form control. */
export function associatedLabelText(el: Element): string | undefined {
  const id = el.getAttribute('id');
  if (id) {
    const lbl = el.ownerDocument.querySelector(`label[for="${cssEscape(id)}"]`);
    if (lbl?.textContent) return lbl.textContent.trim();
  }
  const wrapping = el.closest('label');
  if (wrapping?.textContent) return wrapping.textContent.trim();
  return undefined;
}

/**
 * Find the field's label when it is a sibling under a form-field wrapper
 * (AngularJS/Bootstrap `.form-group`) rather than associated via `for`/wrapping —
 * the common shape for custom controls like `<pbs-date-picker>`. Returns the
 * group's `<label>` text, with required markers ("*"/":") and `&nbsp;` stripped.
 * Returns undefined when the group holds more than one control (ambiguous, would
 * mislabel) or has no label.
 */
export function nearbyLabelText(el: Element): string | undefined {
  const group = el.closest('.form-group, .form-field, .field, [class*="form-group" i]');
  if (!group) return undefined;
  const controls = Array.from(
    group.querySelectorAll('input, select, textarea, [contenteditable=""], [contenteditable="true"]'),
  ).filter((c) => !c.closest(POPUP_SELECTOR));
  if (controls.length !== 1) return undefined;
  const raw = group.querySelector('label')?.textContent;
  if (!raw) return undefined;
  return raw.replace(/\s+/g, ' ').replace(/[\s*:]+$/, '').trim() || undefined;
}

/**
 * An editable, value-bearing control whose text content is *user data*, not a
 * label: a <textarea>, a text-like <input>, or a contenteditable host. Its
 * content must never be used as an accessible name (it would mislabel the field
 * and leak typed/sensitive values).
 */
function isEditableField(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio'].includes(type);
  }
  const editable = el.getAttribute('contenteditable');
  return editable === '' || editable === 'true';
}

/**
 * A form control that a sibling `<label>` can name (input/select/textarea/
 * contenteditable). Used to gate the nearby-label fallback so buttons, links and
 * icons keep deriving their name from their own text content.
 */
function isLabelableControl(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'select' || tag === 'textarea') return true;
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    return !['button', 'submit', 'reset'].includes(type);
  }
  const editable = el.getAttribute('contenteditable');
  return editable === '' || editable === 'true';
}

/** Simplified accessible-name computation (aria-label > labelledby > label > text). */
export function accessibleName(el: Element): string | undefined {
  const ariaLabel = el.getAttribute('aria-label')?.trim();
  if (ariaLabel) return ariaLabel;

  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const text = labelledby
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
    if (text) return text;
  }

  const label = associatedLabelText(el);
  if (label) return label;

  // Sibling <label> in the same field group (AngularJS/Bootstrap .form-group),
  // for controls whose label is neither `for`-associated nor wrapping.
  if (isLabelableControl(el)) {
    const nearby = nearbyLabelText(el);
    if (nearby) return nearby;
  }

  // Skip the element's own content for editable fields — it is user data, not a
  // label, and could expose typed or sensitive values.
  if (!isEditableField(el)) {
    const text = el.textContent?.trim();
    if (text && text.length <= 80) return text;
  }

  return el.getAttribute('placeholder')?.trim() || el.getAttribute('title')?.trim() || undefined;
}

// --- Custom widget (ARIA) selection capture -------------------------------

/** Roles whose click represents *selecting a value* (vs. an action click). */
export const OPTION_ROLE_SELECTOR =
  '[role="option"], [role="menuitemradio"], [role="menuitemcheckbox"]';

/** Containers that hold the options/cells of an open custom widget popup. */
const POPUP_SELECTOR =
  '[role="listbox"], [role="menu"], [role="grid"], [role="tree"], [role="dialog"]';

/** The visible text of a selected option (≤80 chars), or its accessible name. */
export function optionValueText(option: Element): string | undefined {
  const text = option.textContent?.trim();
  if (text && text.length <= 80) return text;
  return accessibleName(option);
}

/** The underlying value of an option (data-value / value / aria-valuenow), else its text. */
export function optionRawValue(option: Element): string | undefined {
  const raw =
    option.getAttribute('data-value') ??
    option.getAttribute('value') ??
    option.getAttribute('aria-valuenow');
  return raw?.trim() || optionValueText(option);
}

/** First element referenced by a space-separated id list (aria-controls/owns). */
function firstReferenced(idList: string | null, doc: Document): Element | null {
  if (!idList) return null;
  for (const id of idList.trim().split(/\s+/)) {
    const el = doc.getElementById(id);
    if (el) return el;
  }
  return null;
}

/**
 * Resolve the form control that owns a clicked option/cell, so its label —
 * not the option text — names the field. Custom widgets (React Select, MUI,
 * Radix, Headless UI) are ARIA-compliant, so we follow aria-controls/owns,
 * aria-activedescendant, and the expanded trigger. Returns null when no
 * owning control can be found (caller falls back to the option itself).
 */
export function resolveOwningControl(node: Element, doc: Document): Element | null {
  // 1. Walk up the popup containers, matching either direction of reference.
  let container: Element | null = node.closest(POPUP_SELECTOR);
  while (container) {
    const controlled = firstReferenced(
      container.getAttribute('aria-controls') ?? container.getAttribute('aria-owns'),
      doc,
    );
    if (controlled) return controlled;
    if (container.id) {
      const byRef = doc.querySelector(
        `[aria-controls~="${cssEscape(container.id)}"], [aria-owns~="${cssEscape(container.id)}"]`,
      );
      if (byRef) return byRef;
    }
    container = container.parentElement?.closest(POPUP_SELECTOR) ?? null;
  }
  // 2. The clicked option is the active descendant of a combobox.
  if (node.id) {
    const byActive = doc.querySelector(`[aria-activedescendant="${cssEscape(node.id)}"]`);
    if (byActive) return byActive;
  }
  // 3. An expanded combobox / popup trigger.
  const expanded = doc.querySelector(
    '[aria-expanded="true"][role="combobox"], [aria-expanded="true"][aria-haspopup]',
  );
  if (expanded) return expanded;
  // 4. The focused control, if it is a field-like role.
  const active = doc.activeElement;
  if (active && ['combobox', 'button', 'textbox'].includes(getRole(active) ?? '')) return active;
  return null;
}

/**
 * Resolve the input a date-picker cell click writes to. ARIA-linked pickers
 * resolve via `resolveOwningControl`; non-ARIA custom pickers (e.g. AngularJS
 * `<pbs-date-picker>` / `uib-datepicker-popup`) render the popup inline next to
 * their text input, so we fall back to DOM proximity — the field within the same
 * `.input-group`/`.form-group`, or a preceding sibling of the popup. Inputs
 * inside the popup itself (e.g. datetime time-spinners) are excluded. Returns
 * null when no field can be found (body-appended popups rely on the ARIA path).
 */
export function resolveDateField(cell: Element, doc: Document): Element | null {
  const owned = resolveOwningControl(cell, doc);
  if (owned && fieldValueOf(owned) !== undefined) return owned;

  const popup = cell.closest(POPUP_SELECTOR);
  const within = (el: Element): boolean => !!popup && popup.contains(el);
  const editableField = (el: Element | null | undefined): Element | null => {
    if (!el) return null;
    const field = el.matches('input, textarea') ? el : el.querySelector('input, textarea');
    return field && isEditableField(field) && !within(field) ? field : null;
  };

  // Primary: the field within the same field-group wrapper.
  const group = cell.closest('.input-group, .form-group, [class*="form-group" i]');
  if (group) {
    for (const candidate of group.querySelectorAll('input, textarea')) {
      if (isEditableField(candidate) && !within(candidate)) return candidate;
    }
  }

  // Complement: a preceding sibling of the popup, walking up a few levels.
  let node: Element | null = popup ?? cell;
  for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
    let sib = node.previousElementSibling;
    while (sib) {
      const field = editableField(sib);
      if (field) return field;
      sib = sib.previousElementSibling;
    }
  }
  return null;
}

// --- Custom lookup (typeahead / autocomplete) capture ----------------------

/**
 * An autocomplete text input — `aria-autocomplete` is list/both/inline. This is
 * the signal Angular-UI-Bootstrap `uib-typeahead` (and ARIA comboboxes) set, and
 * it distinguishes a typeahead lookup (whose committed value lives in the input,
 * not the rendered option) from a plain ARIA listbox/combobox trigger.
 */
export function isAutocompleteInput(el: Element | null): boolean {
  if (!el || el.tagName.toLowerCase() !== 'input') return false;
  const mode = (el.getAttribute('aria-autocomplete') ?? '').toLowerCase();
  return mode === 'list' || mode === 'both' || mode === 'inline';
}

/**
 * Given a click target, resolve the autocomplete input of the lookup whose
 * "open extended search" button was clicked: a <button> within the same
 * `.input-group`/`pbs-lookup` that also holds an autocomplete input. Returns the
 * input, or null when the click is not such a trigger.
 */
export function lookupOpenInput(target: Element): Element | null {
  if (!target.closest('button')) return null;
  const host = target.closest('.input-group, pbs-lookup');
  if (!host) return null;
  for (const input of host.querySelectorAll('input')) {
    if (isAutocompleteInput(input)) return input;
  }
  return null;
}

// --- Click target resolution (semantic + Balanced heuristic) ---------------

/** Elements whose click is unambiguously an action (carry the best label). */
export const SEMANTIC_CLICK_SELECTOR =
  'a, button, input[type="button"], input[type="submit"], input[type="reset"], ' +
  '[role="button"], [role="link"], [role="menuitem"], [role="tab"]';

/** Intent signals that a non-semantic element (icon/div/span) is clickable. */
const HEURISTIC_CLICK_SELECTOR =
  '[onclick], [tabindex]:not([tabindex="-1"]), [aria-haspopup], ' +
  '[class*="btn"], [class*="button"], [class*="icon"]';

/** True if the element's computed cursor is `pointer` (a strong click hint). */
function hasPointerCursor(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  return view.getComputedStyle(el as HTMLElement).cursor === 'pointer';
}

/**
 * Resolve the element a click should be attributed to, or null if the click is
 * not an action. A semantic ancestor (button/link/role) wins so its label names
 * the event even when the click lands on an inner <svg>. Otherwise a Balanced
 * heuristic walks up a few levels for an intent-bearing wrapper (onclick,
 * tabindex, aria-haspopup, btn/button/icon class, or cursor:pointer); a bare
 * icon with no actionable wrapper is still recorded via its own tag.
 */
export function clickActionTarget(target: Element): Element | null {
  const semantic = target.closest(SEMANTIC_CLICK_SELECTOR);
  if (semantic) return semantic;
  let el: Element | null = target;
  for (let depth = 0; el && depth < 4; depth += 1, el = el.parentElement) {
    if (el.matches(HEURISTIC_CLICK_SELECTOR) || hasPointerCursor(el)) return el;
  }
  return target.closest('svg, i');
}

/** Return the calendar cell if `el` sits inside a date-picker popup, else null. */
export function isCalendarCell(el: Element): Element | null {
  const cell = el.closest('[role="gridcell"]');
  if (cell && cell.closest('[role="dialog"], [role="grid"]')) return cell;
  return null;
}

/** The current value of a field control or its descendant input/textarea. */
export function fieldValueOf(control: Element): string | undefined {
  const field = (
    control.matches('input, textarea') ? control : control.querySelector('input, textarea')
  ) as HTMLInputElement | HTMLTextAreaElement | null;
  return field ? field.value.trim() : undefined;
}

/** The human-readable text of the selected option in a native <select>. */
export function selectedOptionText(select: HTMLSelectElement): string | undefined {
  return select.selectedOptions[0]?.text?.trim() || select.value || undefined;
}

/** Build a short, reasonably-stable CSS path as a fallback selector. */
export function cssPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 5) {
    if (node.id) {
      parts.unshift(`#${cssEscape(node.id)}`);
      break;
    }
    let selector = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (sameTag.length > 1) {
        selector += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
    }
    parts.unshift(selector);
    node = parent;
    depth += 1;
  }
  return parts.join(' > ');
}

export function xpath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1) {
    let index = 1;
    let sib = node.previousElementSibling;
    while (sib) {
      if (sib.tagName === node.tagName) index += 1;
      sib = sib.previousElementSibling;
    }
    parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
    node = node.parentElement;
  }
  return '/' + parts.join('/');
}

export function selectorInputFor(el: Element): SelectorInput {
  const name = accessibleName(el);
  const input: SelectorInput = {
    cssPath: cssPath(el),
    xpath: xpath(el),
  };
  const testId = el.getAttribute('data-testid');
  if (testId) input.testId = testId;
  const testAttr = el.getAttribute('data-test');
  if (testAttr) input.testAttr = testAttr;
  const role = getRole(el);
  if (role) input.role = role;
  if (name) input.accessibleName = name;
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) input.ariaLabel = ariaLabel;
  const label = associatedLabelText(el);
  if (label) input.labelText = label;
  const text = el.textContent?.trim();
  // Skip visible text for sensitive fields (e.g. contenteditable) so a secret
  // never leaks into a getByText() selector candidate.
  if (text && text.length <= 40 && !fieldIsSensitive(el)) input.visibleText = text;
  return input;
}

export function elementType(el: Element): ElementType {
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'select';
  if (tag === 'textarea') return 'textarea';
  if (tag === 'form') return 'form';
  if (tag === 'table') return 'table';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    return 'input';
  }
  if (el.getAttribute('role') === 'dialog') return 'dialog';
  return 'other';
}

export function elementState(el: Element): ElementState {
  if ((el as HTMLElement).hidden || el.getAttribute('aria-hidden') === 'true') return 'hidden';
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return 'disabled';
  if (el.hasAttribute('readonly')) return 'readonly';
  return 'enabled';
}

export function fieldIsSensitive(el: Element): boolean {
  return isSensitiveField({
    type: el.getAttribute('type') ?? undefined,
    name: el.getAttribute('name') ?? undefined,
    id: el.getAttribute('id') ?? undefined,
    autocomplete: el.getAttribute('autocomplete') ?? undefined,
    ariaLabel: el.getAttribute('aria-label') ?? undefined,
    label: associatedLabelText(el),
    placeholder: el.getAttribute('placeholder') ?? undefined,
  });
}

/** Build the Layer-2 ElementInfo for an interactable element. */
export function toElementInfo(el: Element, id: string): ElementInfo {
  const input = selectorInputFor(el);
  const info: ElementInfo = {
    id,
    type: elementType(el),
    selectorCandidates: selectorStrings(input),
    state: elementState(el),
  };
  const name = accessibleName(el);
  if (name) info.text = name;
  const role = getRole(el);
  if (role) info.role = role;
  if (name) info.name = name;
  if (fieldIsSensitive(el)) info.sensitive = true;
  return info;
}

/** Exposed for tests: the ranked candidates for an element. */
export function rankedFor(el: Element) {
  return rankSelectors(selectorInputFor(el));
}
