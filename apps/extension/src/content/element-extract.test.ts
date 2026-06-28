import { describe, it, expect, beforeEach } from 'vitest';
import { accessibleName, clickActionTarget } from './element-extract.js';

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
