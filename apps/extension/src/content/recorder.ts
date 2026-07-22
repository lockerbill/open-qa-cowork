import type { ActionEvent, ActionType } from '@qa-copilot/shared';
import {
  accessibleName,
  clickActionTarget,
  fieldIsSensitive,
  fieldValueOf,
  isAutocompleteInput,
  isCalendarCell,
  lookupOpenInput,
  OPTION_ROLE_SELECTOR,
  optionRawValue,
  optionValueText,
  resolveDateField,
  resolveOwningControl,
  selectedOptionText,
  selectorInputFor,
} from './element-extract.js';
import { selectorStrings } from '@qa-copilot/shared';
import { shouldSkipRecorderEvent } from './auto/auto-dispatch.js';

let seq = 0;
function nextId(): string {
  seq += 1;
  return `event_${Date.now().toString(36)}_${seq}`;
}

/** Read visible validation/alert text shortly after an action (spec §9.4). */
function readResultSummary(doc: Document): string | undefined {
  const node = doc.querySelector('[role="alert"], [aria-invalid="true"], .error, .invalid-feedback');
  const text = node?.textContent?.trim();
  return text && text.length <= 200 ? text : undefined;
}

export interface Recorder {
  start(): void;
  stop(): void;
  isRecording(): boolean;
}

/**
 * Records manual QA interactions and emits ordered ActionEvents. Sensitive
 * field values are never stored (spec §9.4). Click/submit emit slightly
 * deferred so any resulting validation message is captured as resultSummary.
 */
export function createRecorder(
  sessionId: string,
  emit: (event: ActionEvent) => void,
  doc: Document = document,
): Recorder {
  let recording = false;
  // Remembers the last selection so a custom-widget option click and the
  // change event from its backing control collapse into a single event.
  let lastSelection: { value?: string; valueText?: string; ts: number } | null = null;
  const DEDUP_WINDOW_MS = 600;
  // Remembers the lookup whose "extended search" modal is open, so a row click
  // in the (body-appended, DOM-detached) modal can be attributed back to its
  // field. Set on open, cleared on consume, TTL-guarded against stale state.
  let pendingLookup: { input: Element; ts: number } | null = null;
  const LOOKUP_TTL_MS = 5 * 60 * 1000;

  const baseEvent = (el: Element | null, type: ActionType): ActionEvent => {
    const ev: ActionEvent = { id: nextId(), sessionId, type, timestamp: new Date().toISOString() };
    if (el) {
      const label = accessibleName(el);
      if (label) ev.targetLabel = label;
      ev.selectorCandidates = selectorStrings(selectorInputFor(el));
    }
    return ev;
  };

  const recentlyEmitted = (value?: string, valueText?: string): boolean => {
    if (!lastSelection || Date.now() - lastSelection.ts > DEDUP_WINDOW_MS) return false;
    return (
      lastSelection.value === value && (lastSelection.valueText ?? '') === (valueText ?? '')
    );
  };

  /** Emit a value-selection event (custom dropdown, native select, date pick), de-duped. */
  const emitSelection = (
    control: Element,
    value: string | undefined,
    valueText: string | undefined,
    valueType: string,
    type: ActionType = 'select',
  ) => {
    if (recentlyEmitted(value, valueText)) return;
    const ev = baseEvent(control, type);
    if (value !== undefined) ev.value = value;
    if (valueText) ev.valueText = valueText;
    ev.valueType = valueType;
    lastSelection = { value, valueText, ts: Date.now() };
    emit(ev);
  };

  /**
   * Snapshot a lookup field's value after its async (AngularJS) update settles
   * and emit it as a single de-duped input event. Used for both the inline
   * typeahead option click and the extended-search modal row click; the field's
   * committed display is more reliable than the rendered option/row text.
   */
  const emitLookup = (input: Element, fallback: string | undefined, delayMs: number) => {
    window.setTimeout(() => {
      const value = fieldValueOf(input) || fallback || '';
      emitSelection(input, value, undefined, 'lookup', 'input');
    }, delayMs);
  };

  const onClick = (e: Event) => {
    // Auto-mode dedupe: the executor's synthetic events are mirrored as
    // explicit source:'auto' events instead (auto-test-mode-spec §6.4.9).
    if (shouldSkipRecorderEvent(e)) return;
    const target = e.target as Element | null;
    if (!target) return;

    // 1. Custom date picker: clicking a calendar cell updates an owned field.
    const cell = isCalendarCell(target);
    if (cell) {
      const owner = resolveDateField(cell, doc);
      if (owner) {
        // The field is updated asynchronously after the click — snapshot it then.
        window.setTimeout(() => {
          const value = fieldValueOf(owner) || cell.textContent?.trim() || '';
          emitSelection(owner, value, undefined, 'date', 'input');
        }, 150);
        return;
      }
    }

    // 2. Selecting an option in a custom combobox/listbox/menu.
    const option = target.closest(OPTION_ROLE_SELECTOR);
    if (option) {
      const owner = resolveOwningControl(option, doc) ?? option;
      // Typeahead/autocomplete lookup: the rendered match may be a messy custom
      // template, so snapshot the input's committed value instead.
      if (isAutocompleteInput(owner)) {
        emitLookup(owner, optionValueText(option), 150);
        return;
      }
      emitSelection(owner, optionRawValue(option), optionValueText(option), 'aria-option');
      return;
    }

    // 3. Selecting a row in a lookup's "extended search" modal updates the field
    //    that opened it (the modal is body-appended and DOM-detached).
    if (pendingLookup && Date.now() - pendingLookup.ts < LOOKUP_TTL_MS) {
      const row = target.closest('tr');
      if (row && target.closest('[role="dialog"], .modal')) {
        const rowText = row.textContent?.replace(/\s+/g, ' ').trim().slice(0, 80);
        emitLookup(pendingLookup.input, rowText, 250);
        pendingLookup = null;
        return;
      }
    }

    // 4. Opening a lookup's extended-search modal: remember its field, suppress
    //    the trigger click (it is plumbing, not a recorded step).
    const lookupInput = lookupOpenInput(target);
    if (lookupInput) {
      pendingLookup = { input: lookupInput, ts: Date.now() };
      return;
    }

    // 5. Generic action click: a semantic element (link/button/menuitem/tab) or
    //    a Balanced-heuristic clickable (icon/div/span showing interaction intent).
    const el = clickActionTarget(target);
    if (!el) return;
    const ev = baseEvent(el, 'click');
    // Defer to capture any validation that appears as a result.
    window.setTimeout(() => {
      const summary = readResultSummary(doc);
      if (summary) ev.resultSummary = summary;
      emit(ev);
    }, 250);
  };

  const onChange = (e: Event) => {
    if (shouldSkipRecorderEvent(e)) return;
    const el = e.target as HTMLInputElement | HTMLSelectElement | null;
    if (!el) return;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') ?? '').toLowerCase();

    if (tag === 'select') {
      // Record the visible option text alongside the raw value; de-dup against a
      // custom dropdown that just emitted the same selection.
      emitSelection(el, (el as HTMLSelectElement).value, selectedOptionText(el as HTMLSelectElement), 'option');
      return;
    }
    if (type === 'checkbox') {
      const ev = baseEvent(el, 'checkbox');
      ev.value = String((el as HTMLInputElement).checked);
      emit(ev);
      return;
    }
    if (type === 'radio') {
      const ev = baseEvent(el, 'radio');
      ev.value = (el as HTMLInputElement).value;
      emit(ev);
      return;
    }
    // text-like input / textarea
    const ev = baseEvent(el, 'input');
    if (fieldIsSensitive(el)) {
      ev.valueType = 'sensitive'; // value intentionally omitted
    } else {
      ev.value = (el as HTMLInputElement).value;
      ev.valueType = 'text';
    }
    emit(ev);
  };

  const onSubmit = (e: Event) => {
    if (shouldSkipRecorderEvent(e)) return;
    const form = e.target as HTMLFormElement | null;
    const ev = baseEvent(form, 'submit');
    window.setTimeout(() => {
      const summary = readResultSummary(doc);
      if (summary) ev.resultSummary = summary;
      emit(ev);
    }, 250);
  };

  // Contenteditable fields fire no `change`; capture the committed text on blur.
  const onFocusOut = (e: Event) => {
    if (shouldSkipRecorderEvent(e)) return;
    const el = (e.target as Element | null)?.closest('[contenteditable=""], [contenteditable="true"]');
    if (!el) return;
    const ev = baseEvent(el, 'input');
    if (fieldIsSensitive(el)) {
      ev.valueType = 'sensitive'; // value intentionally omitted
    } else {
      const text = el.textContent?.trim();
      if (text) ev.value = text;
      ev.valueType = 'text';
    }
    emit(ev);
  };

  return {
    start() {
      if (recording) return;
      recording = true;
      doc.addEventListener('click', onClick, true);
      doc.addEventListener('change', onChange, true);
      doc.addEventListener('submit', onSubmit, true);
      doc.addEventListener('focusout', onFocusOut, true);
    },
    stop() {
      if (!recording) return;
      recording = false;
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('change', onChange, true);
      doc.removeEventListener('submit', onSubmit, true);
      doc.removeEventListener('focusout', onFocusOut, true);
    },
    isRecording: () => recording,
  };
}
