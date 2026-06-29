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

  it('records a non-ARIA custom date picker (pbs-date-picker) with full value and group label', () => {
    document.body.innerHTML = `
      <div class="form-group">
        <label>Blanket Start Date<abbr ng-show="true">&nbsp;*</abbr></label>
        <pbs-date-picker pbs-model="ctrl.model.BlanketStartDate">
          <div class="input-group" ng-form="datepickerForm">
            <input class="form-control" type="text" uib-datepicker-popup="dd/MM/yyyy" placeholder="dd/MM/yyyy" />
            <div uib-datepicker-popup-wrap>
              <table role="grid"><tbody><tr>
                <td role="gridcell"><button type="button"><span>28</span></button></td>
                <td role="gridcell"><button type="button"><span>29</span></button></td>
              </tr></tbody></table>
            </div>
            <div class="input-group-btn"><a class="btn"><i class="far fa-calendar-alt"></i></a></div>
          </div>
        </pbs-date-picker>
      </div>`;
    const session = record();
    rec = session.rec;
    click(document.querySelectorAll('[role="gridcell"] span')[1]!);
    // Angular updates the bound input asynchronously after the click.
    document.querySelector<HTMLInputElement>('input')!.value = '29/06/2026';
    vi.advanceTimersByTime(200);

    expect(session.events).toHaveLength(1);
    const ev = session.events[0]!;
    expect(ev.type).toBe('input');
    expect(ev.valueType).toBe('date');
    expect(ev.value).toBe('29/06/2026');
    expect(ev.valueText).toBeUndefined();
    expect(ev.targetLabel).toBe('Blanket Start Date');
  });

  it('records the full date value even when the picker has no label', () => {
    document.body.innerHTML = `
      <div class="input-group">
        <input class="form-control" type="text" uib-datepicker-popup="dd/MM/yyyy" />
        <div uib-datepicker-popup-wrap>
          <table role="grid"><tbody><tr>
            <td role="gridcell"><button type="button"><span>29</span></button></td>
          </tr></tbody></table>
        </div>
      </div>`;
    const session = record();
    rec = session.rec;
    click(document.querySelector('[role="gridcell"] span')!);
    document.querySelector<HTMLInputElement>('input')!.value = '29/06/2026';
    vi.advanceTimersByTime(200);

    expect(session.events).toHaveLength(1);
    const ev = session.events[0]!;
    expect(ev.type).toBe('input');
    expect(ev.valueType).toBe('date');
    expect(ev.value).toBe('29/06/2026');
    expect(ev.targetLabel).toBeUndefined();
  });

  it('records an inline typeahead lookup by snapshotting the input, not the option template', () => {
    document.body.innerHTML = `
      <div class="form-group">
        <label>Vendor Code</label>
        <pbs-lookup>
          <div class="input-group">
            <input type="text" aria-autocomplete="list" aria-owns="tap" placeholder="Type to Search" />
            <ul id="tap" role="listbox">
              <li role="option"><div><strong>ABC</strong> Metals — EPIC06 — USD — 2730 Broadway, St. Paul MN 55113</div></li>
            </ul>
          </div>
        </pbs-lookup>
      </div>`;
    const session = record();
    rec = session.rec;
    click(document.querySelector('[role="option"] strong')!);
    // uib-typeahead updates the bound input asynchronously after the click.
    document.querySelector<HTMLInputElement>('input')!.value = 'ABC Metals';
    vi.advanceTimersByTime(200);

    expect(session.events).toHaveLength(1);
    const ev = session.events[0]!;
    expect(ev.type).toBe('input');
    expect(ev.valueType).toBe('lookup');
    expect(ev.value).toBe('ABC Metals');
    expect(ev.targetLabel).toBe('Vendor Code');
  });

  it('records an extended-search modal row selection against the originating field', () => {
    document.body.innerHTML = `
      <div class="form-group">
        <label>Vendor Code</label>
        <pbs-lookup>
          <div class="input-group">
            <input type="text" aria-autocomplete="list" placeholder="Type to Search" />
            <div class="input-group-btn"><button type="button"><i class="fa fa-search"></i></button></div>
          </div>
        </pbs-lookup>
      </div>`;
    const session = record();
    rec = session.rec;

    // Opening the modal is plumbing — no event, but the field is remembered.
    click(document.querySelector('button i')!);
    expect(session.events).toHaveLength(0);

    // uib appends the modal to <body>, detached from the field.
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.innerHTML = `
      <table class="table">
        <tbody>
          <tr ng-click="ctrl.selectItem(item)"><td>EPIC06</td><td>ABCM</td><td><small>ABC Metals</small></td></tr>
        </tbody>
      </table>`;
    document.body.appendChild(modal);

    click(modal.querySelector('small')!);
    // Selecting a row writes the value back to the field and closes the modal.
    document.querySelector<HTMLInputElement>('input')!.value = 'ABCM';
    vi.advanceTimersByTime(300);

    expect(session.events).toHaveLength(1);
    const ev = session.events[0]!;
    expect(ev.type).toBe('input');
    expect(ev.valueType).toBe('lookup');
    expect(ev.value).toBe('ABCM');
    expect(ev.targetLabel).toBe('Vendor Code');
  });

  it('records free-typed text in a lookup input via the normal change path', () => {
    document.body.innerHTML = `
      <div class="form-group">
        <label>Vendor Code</label>
        <pbs-lookup>
          <div class="input-group">
            <input type="text" aria-autocomplete="list" placeholder="Type to Search" />
          </div>
        </pbs-lookup>
      </div>`;
    const session = record();
    rec = session.rec;
    const input = document.querySelector<HTMLInputElement>('input')!;
    input.value = 'CUSTOM';
    change(input);

    expect(session.events).toHaveLength(1);
    const ev = session.events[0]!;
    expect(ev.type).toBe('input');
    expect(ev.valueType).toBe('text');
    expect(ev.value).toBe('CUSTOM');
    expect(ev.targetLabel).toBe('Vendor Code');
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
