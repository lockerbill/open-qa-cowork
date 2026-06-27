import { describe, it, expect, beforeEach } from 'vitest';
import { scanPage } from './scanner.js';

const HTML = `
  <h1>Create Purchase Order</h1>
  <form>
    <label for="supplier">Supplier</label>
    <input id="supplier" name="supplier" data-testid="supplier-input" />

    <label for="qty">Quantity</label>
    <input id="qty" name="qty" type="number" required />

    <label for="pw">Password</label>
    <input id="pw" name="password" type="password" />

    <label for="terms">Accept terms</label>
    <input id="terms" type="checkbox" />

    <select id="warehouse" aria-label="Warehouse">
      <option>North</option>
      <option>South</option>
    </select>

    <button type="submit" data-testid="submit-order">Submit</button>
    <button type="button">Cancel</button>
  </form>
  <a href="/help">Help</a>
  <table><caption>Lines</caption><thead><tr><th>Item</th><th>Qty</th></tr></thead>
    <tbody><tr><td>A</td><td>1</td></tr></tbody></table>
  <div role="alert" class="error">Release date is required</div>
`;

describe('scanPage (spec §9.2, §10)', () => {
  beforeEach(() => {
    document.title = 'Create Purchase Order';
    document.body.innerHTML = HTML;
  });

  it('detects at least 90% of interactable elements (spec §17.2)', () => {
    const model = scanPage(document, new URL('http://localhost/orders/create'));
    // Interactables: supplier, qty, pw, terms, warehouse, submit, cancel, help = 8
    const interactableCount = document.querySelectorAll(
      'a[href], button, input, select, textarea',
    ).length;
    expect(model.elements.length / interactableCount).toBeGreaterThanOrEqual(0.9);
  });

  it('flags the password field as sensitive and never stores a value', () => {
    document.querySelector<HTMLInputElement>('#pw')!.value = 'hunter2';
    const model = scanPage(document, new URL('http://localhost/orders/create'));
    const pw = model.elements.find((e) => e.type === 'input' && e.sensitive);
    expect(pw).toBeTruthy();
    // ElementInfo has no value field at all — assert no secret leaks anywhere.
    expect(JSON.stringify(model)).not.toContain('hunter2');
  });

  it('summarizes buttons, forms, tables and validation messages', () => {
    const model = scanPage(document, new URL('http://localhost/orders/create'));
    expect(model.summary.title).toBe('Create Purchase Order');
    expect(model.summary.buttons).toContain('Submit');
    expect(model.summary.buttons).toContain('Cancel');
    expect(model.summary.forms).toHaveLength(1);
    expect(model.summary.forms[0]?.fields.some((f) => f.required)).toBe(true);
    expect(model.summary.forms[0]?.fields.some((f) => f.sensitive)).toBe(true);
    expect(model.summary.tables[0]?.columnHeaders).toEqual(['Item', 'Qty']);
    expect(model.summary.validationMessages).toContain('Release date is required');
  });

  it('prefers data-testid in selector candidates (spec §9.10)', () => {
    const model = scanPage(document, new URL('http://localhost/orders/create'));
    const submit = model.elements.find((e) => e.text === 'Submit');
    expect(submit?.selectorCandidates[0]).toBe("getByTestId('submit-order')");
  });
});
