import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ActionEvent } from '@qa-copilot/shared';
import { createRecorder } from './recorder.js';

/** Spin up a recording session over the current document and capture emits. */
function record() {
  const events: ActionEvent[] = [];
  const rec = createRecorder('s1', (e) => events.push(e), document);
  rec.start();
  return { events, rec };
}

function click(el: Element) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function change(el: Element) {
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('createRecorder — input & custom widget capture', () => {
  let rec: { stop(): void } | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    rec?.stop();
    rec = null;
    vi.useRealTimers();
  });

  it('records a native <select> with raw value and visible option text', () => {
    document.body.innerHTML = `
      <select id="wh" aria-label="Warehouse">
        <option value="n">North</option>
        <option value="s">South</option>
      </select>`;
    const session = record();
    rec = session.rec;
    const sel = document.querySelector<HTMLSelectElement>('#wh')!;
    sel.value = 's';
    change(sel);

    expect(session.events).toHaveLength(1);
    const ev = session.events[0]!;
    expect(ev.type).toBe('select');
    expect(ev.value).toBe('s');
    expect(ev.valueText).toBe('South');
    expect(ev.valueType).toBe('option');
    expect(ev.targetLabel).toBe('Warehouse');
  });

  it('records an ARIA combobox/listbox option, labelled by the control not the option', () => {
    document.body.innerHTML = `
      <div role="combobox" aria-label="Country" aria-controls="lb" aria-expanded="true">United States</div>
      <ul id="lb" role="listbox">
        <li role="option" data-value="ca">Canada</li>
        <li role="option" data-value="us">United States</li>
      </ul>`;
    const session = record();
    rec = session.rec;
    click(document.querySelector('[data-value="ca"]')!);

    expect(session.events).toHaveLength(1);
    const ev = session.events[0]!;
    expect(ev.type).toBe('select');
    expect(ev.valueType).toBe('aria-option');
    expect(ev.value).toBe('ca');
    expect(ev.valueText).toBe('Canada');
    expect(ev.targetLabel).toBe('Country');
  });

  it('resolves the owning control via aria-activedescendant', () => {
    document.body.innerHTML = `
      <input role="combobox" aria-label="City" aria-activedescendant="opt2" />
      <ul role="listbox">
        <li id="opt1" role="option">Paris</li>
        <li id="opt2" role="option">London</li>
      </ul>`;
    const session = record();
    rec = session.rec;
    click(document.querySelector('#opt2')!);

    expect(session.events).toHaveLength(1);
    const ev = session.events[0]!;
    expect(ev.type).toBe('select');
    expect(ev.valueText).toBe('London');
    expect(ev.targetLabel).toBe('City');
  });

  it('records a menuitemradio selection as a select', () => {
    document.body.innerHTML = `
      <button id="sort" aria-controls="menu" aria-expanded="true">Sort</button>
      <div id="menu" role="menu">
        <div role="menuitemradio" aria-checked="false">Name</div>
        <div role="menuitemradio" aria-checked="true">Date</div>
      </div>`;
    const session = record();
    rec = session.rec;
    click(document.querySelectorAll('[role="menuitemradio"]')[1]!);

    expect(session.events).toHaveLength(1);
    const ev = session.events[0]!;
    expect(ev.type).toBe('select');
    expect(ev.valueText).toBe('Date');
    expect(ev.targetLabel).toBe('Sort');
  });

  it('records a custom date picker cell as a date input, snapshotting the field value', () => {
    document.body.innerHTML = `
      <label for="dob">Date of birth</label>
      <input id="dob" readonly />
      <div role="dialog" aria-controls="dob">
        <div role="grid">
          <button role="gridcell">14</button>
          <button role="gridcell">15</button>
        </div>
      </div>`;
    const session = record();
    rec = session.rec;
    const cell = document.querySelectorAll('[role="gridcell"]')[1]!;
    click(cell);
    // The picker updates the field asynchronously after the click.
    document.querySelector<HTMLInputElement>('#dob')!.value = '2026-06-15';
    vi.advanceTimersByTime(200);

    expect(session.events).toHaveLength(1);
    const ev = session.events[0]!;
    expect(ev.type).toBe('input');
    expect(ev.valueType).toBe('date');
    expect(ev.value).toBe('2026-06-15');
    expect(ev.targetLabel).toBe('Date of birth');
  });

  it('de-duplicates an option click followed by a backing <select> change', () => {
    document.body.innerHTML = `
      <div role="combobox" aria-label="Region" aria-controls="lb" aria-expanded="true">North</div>
      <ul id="lb" role="listbox">
        <li role="option" data-value="s">South</li>
      </ul>
      <select id="hidden" aria-label="Region" style="display:none">
        <option value="n">North</option>
        <option value="s">South</option>
      </select>`;
    const session = record();
    rec = session.rec;
    click(document.querySelector('[data-value="s"]')!);
    const hidden = document.querySelector<HTMLSelectElement>('#hidden')!;
    hidden.value = 's';
    change(hidden);

    expect(session.events).toHaveLength(1);
    expect(session.events[0]!.valueText).toBe('South');
  });

  it('records a contenteditable field once, on focusout', () => {
    document.body.innerHTML = `<div contenteditable="true" aria-label="Bio">Hello world</div>`;
    const session = record();
    rec = session.rec;
    const el = document.querySelector('[contenteditable]')!;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

    expect(session.events).toHaveLength(1);
    const ev = session.events[0]!;
    expect(ev.type).toBe('input');
    expect(ev.value).toBe('Hello world');
    expect(ev.valueType).toBe('text');
    expect(ev.targetLabel).toBe('Bio');
  });

  it('never stores the value of a sensitive contenteditable field', () => {
    document.body.innerHTML = `<div contenteditable="true" aria-label="Password">secret123</div>`;
    const session = record();
    rec = session.rec;
    document.querySelector('[contenteditable]')!.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true }),
    );

    expect(session.events).toHaveLength(1);
    expect(session.events[0]!.valueType).toBe('sensitive');
    expect(session.events[0]!.value).toBeUndefined();
    expect(JSON.stringify(session.events)).not.toContain('secret123');
  });

  it('records a multi-line <textarea>, keeping newlines and labelling from <label>', () => {
    document.body.innerHTML = `
      <label for="notes">Notes</label>
      <textarea id="notes"></textarea>`;
    const session = record();
    rec = session.rec;
    const ta = document.querySelector<HTMLTextAreaElement>('#notes')!;
    ta.value = 'line one\nline two';
    change(ta);

    expect(session.events).toHaveLength(1);
    const ev = session.events[0]!;
    expect(ev.type).toBe('input');
    expect(ev.valueType).toBe('text');
    expect(ev.value).toBe('line one\nline two');
    expect(ev.targetLabel).toBe('Notes');
  });

  it('does not leak an unlabeled textarea value into the label', () => {
    document.body.innerHTML = `<textarea placeholder="Add a comment"></textarea>`;
    const session = record();
    rec = session.rec;
    const ta = document.querySelector<HTMLTextAreaElement>('textarea')!;
    ta.value = 'private note';
    change(ta);

    expect(session.events).toHaveLength(1);
    const ev = session.events[0]!;
    expect(ev.value).toBe('private note');
    expect(ev.targetLabel).toBe('Add a comment');
  });

  it('records a click on an icon button (div wrapper, no role) labelled by the wrapper', () => {
    document.body.innerHTML = `<div class="icon-btn" title="Edit"><svg></svg></div>`;
    const session = record();
    rec = session.rec;
    click(document.querySelector('svg')!);
    vi.advanceTimersByTime(300);

    expect(session.events).toHaveLength(1);
    const ev = session.events[0]!;
    expect(ev.type).toBe('click');
    expect(ev.targetLabel).toBe('Edit');
  });

  it('records a click on a span with an onclick handler', () => {
    document.body.innerHTML = `<span onclick="void 0">Save</span>`;
    const session = record();
    rec = session.rec;
    click(document.querySelector('span')!);
    vi.advanceTimersByTime(300);

    expect(session.events).toHaveLength(1);
    expect(session.events[0]!.type).toBe('click');
    expect(session.events[0]!.targetLabel).toBe('Save');
  });

  it('records a click on a cursor:pointer div', () => {
    document.body.innerHTML = `<div style="cursor:pointer">Apply</div>`;
    const session = record();
    rec = session.rec;
    click(document.querySelector('div')!);
    vi.advanceTimersByTime(300);

    expect(session.events).toHaveLength(1);
    expect(session.events[0]!.type).toBe('click');
  });

  it('records an unlabeled icon-only clickable via its selector candidates', () => {
    document.body.innerHTML = `<i class="icon-trash" onclick="void 0"></i>`;
    const session = record();
    rec = session.rec;
    click(document.querySelector('i')!);
    vi.advanceTimersByTime(300);

    expect(session.events).toHaveLength(1);
    const ev = session.events[0]!;
    expect(ev.type).toBe('click');
    expect(ev.targetLabel).toBeUndefined();
    expect(ev.selectorCandidates?.length).toBeGreaterThan(0);
  });

  it('ignores a click on plain, non-actionable text', () => {
    document.body.innerHTML = `<p>just some paragraph text</p>`;
    const session = record();
    rec = session.rec;
    click(document.querySelector('p')!);
    vi.advanceTimersByTime(300);

    expect(session.events).toHaveLength(0);
  });

  it('records a plain role="menuitem" as a click, not a selection', () => {
    document.body.innerHTML = `<div role="menu"><div role="menuitem">Delete</div></div>`;
    const session = record();
    rec = session.rec;
    click(document.querySelector('[role="menuitem"]')!);
    vi.advanceTimersByTime(300);

    expect(session.events).toHaveLength(1);
    const ev = session.events[0]!;
    expect(ev.type).toBe('click');
    expect(ev.targetLabel).toBe('Delete');
  });
});
