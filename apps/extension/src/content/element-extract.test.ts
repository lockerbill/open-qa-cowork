import { describe, it, expect, beforeEach } from 'vitest';
import {
  accessibleName,
  clickActionTarget,
  isAutocompleteInput,
  lookupOpenInput,
  resolveDateField,
} from './element-extract.js';

describe('accessibleName — editable fields never expose their own content as a label', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('uses an associated <label> for a textarea, not its content', () => {
    document.body.innerHTML = `
      <label for="notes">Notes</label>
      <textarea id="notes">typed content here</textarea>`;
    const ta = document.querySelector('textarea')!;
    expect(accessibleName(ta)).toBe('Notes');
  });

  it('does not leak a textarea value into the label when there is no <label>', () => {
    document.body.innerHTML = `<textarea>secret default content</textarea>`;
    const ta = document.querySelector('textarea')!;
    expect(accessibleName(ta)).toBeUndefined();
  });

  it('falls back to placeholder/title for an unlabeled textarea instead of its content', () => {
    document.body.innerHTML = `<textarea placeholder="Add a comment">draft text</textarea>`;
    const ta = document.querySelector('textarea')!;
    expect(accessibleName(ta)).toBe('Add a comment');
  });

  it('does not leak a contenteditable value into the label', () => {
    document.body.innerHTML = `<div contenteditable="true">user typed body</div>`;
    const el = document.querySelector('[contenteditable]')!;
    expect(accessibleName(el)).toBeUndefined();
  });

  it('still uses textContent for non-editable elements (e.g. a button)', () => {
    document.body.innerHTML = `<button>Save</button>`;
    expect(accessibleName(document.querySelector('button')!)).toBe('Save');
  });

  it('names a control from a sibling <label> in the same .form-group, stripping required markers', () => {
    document.body.innerHTML = `
      <div class="form-group">
        <label>Blanket Start Date<abbr ng-show="true">&nbsp;*</abbr></label>
        <input type="text" placeholder="dd/MM/yyyy" />
      </div>`;
    expect(accessibleName(document.querySelector('input')!)).toBe('Blanket Start Date');
  });

  it('does not use the group label when the .form-group holds multiple controls', () => {
    document.body.innerHTML = `
      <div class="form-group">
        <label>Range</label>
        <input placeholder="from" />
        <input placeholder="to" />
      </div>`;
    expect(accessibleName(document.querySelector('input')!)).toBe('from');
  });

  it('prefers a label[for] over a sibling group label', () => {
    document.body.innerHTML = `
      <div class="form-group">
        <label for="x">Linked</label>
        <input id="x" placeholder="ph" />
      </div>`;
    expect(accessibleName(document.querySelector('#x')!)).toBe('Linked');
  });

  it('keeps textContent for a button inside a .form-group (not the group label)', () => {
    document.body.innerHTML = `
      <div class="form-group">
        <label>Group</label>
        <button>Save</button>
      </div>`;
    expect(accessibleName(document.querySelector('button')!)).toBe('Save');
  });

  it('names a pbs-lookup input from its .form-group label', () => {
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
    expect(accessibleName(document.querySelector('input')!)).toBe('Vendor Code');
  });
});

describe('lookup helpers — isAutocompleteInput / lookupOpenInput', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('detects an autocomplete input by aria-autocomplete', () => {
    document.body.innerHTML = `
      <input id="ac" aria-autocomplete="list" />
      <input id="cb" role="combobox" />
      <div id="d"></div>`;
    expect(isAutocompleteInput(document.querySelector('#ac'))).toBe(true);
    expect(isAutocompleteInput(document.querySelector('#cb'))).toBe(false);
    expect(isAutocompleteInput(document.querySelector('#d'))).toBe(false);
  });

  it('resolves the autocomplete input when clicking the lookup button in the same group', () => {
    document.body.innerHTML = `
      <div class="input-group">
        <input type="text" aria-autocomplete="list" />
        <div class="input-group-btn"><button type="button"><i class="fa fa-search"></i></button></div>
      </div>`;
    const icon = document.querySelector('i')!;
    expect(lookupOpenInput(icon)).toBe(document.querySelector('input'));
  });

  it('returns null when the clicked button has no autocomplete input in its group', () => {
    document.body.innerHTML = `
      <div class="input-group">
        <input type="text" />
        <div class="input-group-btn"><button type="button">Go</button></div>
      </div>`;
    expect(lookupOpenInput(document.querySelector('button')!)).toBeNull();
  });
});

describe('resolveDateField — find the input a calendar cell writes to', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves the input by DOM proximity for a non-ARIA inline picker (pbs-date-picker)', () => {
    document.body.innerHTML = `
      <div class="form-group">
        <label>Blanket Start Date</label>
        <pbs-date-picker>
          <div class="input-group">
            <input type="text" uib-datepicker-popup="dd/MM/yyyy" placeholder="dd/MM/yyyy" />
            <div uib-datepicker-popup-wrap>
              <table role="grid"><tbody><tr>
                <td role="gridcell"><button type="button"><span>29</span></button></td>
              </tr></tbody></table>
            </div>
          </div>
        </pbs-date-picker>
      </div>`;
    const cell = document.querySelector('[role="gridcell"]')!;
    expect(resolveDateField(cell, document)).toBe(document.querySelector('input'));
  });

  it('resolves via ARIA aria-controls when present', () => {
    document.body.innerHTML = `
      <input id="dob" readonly />
      <div role="dialog" aria-controls="dob">
        <div role="grid"><button role="gridcell">15</button></div>
      </div>`;
    const cell = document.querySelector('[role="gridcell"]')!;
    expect(resolveDateField(cell, document)).toBe(document.querySelector('#dob'));
  });

  it('excludes an input rendered inside the popup (e.g. a time spinner)', () => {
    document.body.innerHTML = `
      <div class="input-group">
        <input id="field" type="text" />
        <div uib-datepicker-popup-wrap>
          <table role="grid"><tbody><tr>
            <td role="gridcell"><button type="button"><span>29</span></button></td>
          </tr></tbody></table>
          <input id="spinner" type="text" />
        </div>
      </div>`;
    const cell = document.querySelector('[role="gridcell"]')!;
    expect(resolveDateField(cell, document)).toBe(document.querySelector('#field'));
  });
});

describe('clickActionTarget — Balanced detection of non-button actions', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const t = (sel: string) => document.querySelector(sel)!;

  it('prefers a semantic ancestor (button) when clicking an inner icon', () => {
    document.body.innerHTML = `<button id="b" title="Edit"><svg id="i"></svg></button>`;
    expect(clickActionTarget(t('#i'))).toBe(t('#b'));
  });

  it('attributes an icon click to its actionable wrapper div', () => {
    document.body.innerHTML = `<div id="w" class="icon-btn" title="Edit"><svg id="i"></svg></div>`;
    expect(clickActionTarget(t('#i'))).toBe(t('#w'));
  });

  it('treats an element with an onclick handler as an action', () => {
    document.body.innerHTML = `<span id="s" onclick="x()">Save</span>`;
    expect(clickActionTarget(t('#s'))).toBe(t('#s'));
  });

  it('treats a cursor:pointer element as an action', () => {
    document.body.innerHTML = `<div id="d" style="cursor:pointer">Apply</div>`;
    expect(clickActionTarget(t('#d'))).toBe(t('#d'));
  });

  it('records a bare icon-only clickable even without other signals via its tag', () => {
    document.body.innerHTML = `<i id="i" class="icon-trash" onclick="x()"></i>`;
    expect(clickActionTarget(t('#i'))).toBe(t('#i'));
  });

  it('returns null for a plain non-actionable click (paragraph text)', () => {
    document.body.innerHTML = `<p id="p">just some text</p>`;
    expect(clickActionTarget(t('#p'))).toBeNull();
  });
});
