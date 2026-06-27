import type {
  ElementInfo,
  FormFieldInfo,
  FormInfo,
  PageModel,
  PageSummary,
  TableInfo,
} from '@qa-copilot/shared';
import {
  accessibleName,
  associatedLabelText as labelFor,
  elementType,
  fieldIsSensitive,
  toElementInfo,
} from './element-extract.js';

const INTERACTABLE =
  'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="dialog"]';

function isVisible(el: Element): boolean {
  const he = el as HTMLElement;
  if (he.hidden) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(he);
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  return true;
}

function uniqueText(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const t = v?.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function scanForms(doc: Document, idFor: (el: Element) => string): FormInfo[] {
  return Array.from(doc.querySelectorAll('form')).map((form, i) => {
    const fields: FormFieldInfo[] = Array.from(
      form.querySelectorAll('input, select, textarea'),
    ).map((el) => {
      const field: FormFieldInfo = {
        id: idFor(el),
        inputType: (el.getAttribute('type') ?? el.tagName.toLowerCase()).toLowerCase(),
        required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
      };
      const label = labelFor(el) ?? accessibleName(el);
      if (label) field.label = label;
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) field.placeholder = placeholder;
      if (fieldIsSensitive(el)) field.sensitive = true;
      return field;
    });
    const submitLabels = uniqueText(
      Array.from(form.querySelectorAll('button, input[type="submit"]')).map(
        (b) => accessibleName(b) ?? b.getAttribute('value'),
      ),
    );
    const info: FormInfo = { id: `form_${i}`, fields, submitLabels };
    const name = form.getAttribute('name') ?? accessibleName(form);
    if (name) info.name = name;
    return info;
  });
}

function scanTables(doc: Document): TableInfo[] {
  return Array.from(doc.querySelectorAll('table')).map((table, i) => {
    const headers = uniqueText(
      Array.from(table.querySelectorAll('thead th, tr:first-child th')).map((th) => th.textContent),
    );
    const info: TableInfo = {
      id: `table_${i}`,
      columnHeaders: headers,
      rowCount: table.querySelectorAll('tbody tr, tr').length,
    };
    const caption = table.querySelector('caption')?.textContent?.trim();
    if (caption) info.caption = caption;
    return info;
  });
}

function scanValidationMessages(doc: Document): string[] {
  return uniqueText(
    Array.from(
      doc.querySelectorAll('[role="alert"], [aria-invalid="true"], .error, .invalid-feedback'),
    ).map((el) => el.textContent),
  ).slice(0, 25);
}

function scanModals(doc: Document): string[] {
  return uniqueText(
    Array.from(doc.querySelectorAll('[role="dialog"], dialog[open]')).map(
      (el) => accessibleName(el) ?? el.getAttribute('aria-label'),
    ),
  );
}

/**
 * Build the layered page model (spec §10). Takes the Document + location so it
 * is unit-testable under jsdom. Raw DOM is never included; sensitive field
 * values are never read.
 */
export function scanPage(doc: Document, loc: Location | URL): PageModel {
  let counter = 0;
  const ids = new WeakMap<Element, string>();
  const idFor = (el: Element): string => {
    let id = ids.get(el);
    if (!id) {
      id = `el_${counter++}`;
      ids.set(el, id);
    }
    return id;
  };

  const interactables = Array.from(doc.querySelectorAll(INTERACTABLE)).filter(isVisible);
  const elements: ElementInfo[] = interactables.map((el) => toElementInfo(el, idFor(el)));

  const summary: PageSummary = {
    url: typeof loc === 'object' && 'href' in loc ? loc.href : String(loc),
    route: 'pathname' in loc ? loc.pathname + (loc.hash ?? '') : '',
    title: doc.title,
    headings: uniqueText(
      Array.from(doc.querySelectorAll('h1, h2, h3')).map((h) => h.textContent),
    ).slice(0, 30),
    forms: scanForms(doc, idFor),
    buttons: uniqueText(
      interactables.filter((el) => elementType(el) === 'button').map((el) => accessibleName(el)),
    ),
    links: uniqueText(
      interactables.filter((el) => elementType(el) === 'link').map((el) => accessibleName(el)),
    ).slice(0, 50),
    tables: scanTables(doc),
    modals: scanModals(doc),
    validationMessages: scanValidationMessages(doc),
    consoleErrors: [],
    networkFailures: [],
  };

  return { summary, elements, capturedAt: new Date().toISOString() };
}
