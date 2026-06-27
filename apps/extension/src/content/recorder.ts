import type { ActionEvent, ActionType } from '@qa-copilot/shared';
import { accessibleName, fieldIsSensitive, selectorInputFor } from './element-extract.js';
import { selectorStrings } from '@qa-copilot/shared';

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

  const baseEvent = (el: Element | null, type: ActionType): ActionEvent => {
    const ev: ActionEvent = { id: nextId(), sessionId, type, timestamp: new Date().toISOString() };
    if (el) {
      const label = accessibleName(el);
      if (label) ev.targetLabel = label;
      ev.selectorCandidates = selectorStrings(selectorInputFor(el));
    }
    return ev;
  };

  const onClick = (e: Event) => {
    const el = (e.target as Element | null)?.closest(
      'a, button, input[type="button"], input[type="submit"], [role="button"], [role="link"]',
    );
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
    const el = e.target as HTMLInputElement | HTMLSelectElement | null;
    if (!el) return;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') ?? '').toLowerCase();

    if (tag === 'select') {
      const ev = baseEvent(el, 'select');
      ev.value = (el as HTMLSelectElement).value;
      ev.valueType = 'option';
      emit(ev);
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
    const form = e.target as HTMLFormElement | null;
    const ev = baseEvent(form, 'submit');
    window.setTimeout(() => {
      const summary = readResultSummary(doc);
      if (summary) ev.resultSummary = summary;
      emit(ev);
    }, 250);
  };

  return {
    start() {
      if (recording) return;
      recording = true;
      doc.addEventListener('click', onClick, true);
      doc.addEventListener('change', onChange, true);
      doc.addEventListener('submit', onSubmit, true);
    },
    stop() {
      if (!recording) return;
      recording = false;
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('change', onChange, true);
      doc.removeEventListener('submit', onSubmit, true);
    },
    isRecording: () => recording,
  };
}
