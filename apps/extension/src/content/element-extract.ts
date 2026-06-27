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

  const text = el.textContent?.trim();
  if (text && text.length <= 80) return text;

  return el.getAttribute('placeholder')?.trim() || el.getAttribute('title')?.trim() || undefined;
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
  if (text && text.length <= 40) input.visibleText = text;
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
