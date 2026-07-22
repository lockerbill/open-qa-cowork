import { describe, it, expect } from 'vitest';
import { redactText, REDACTED } from '@qa-copilot/shared';
import { capText, isSecretAttributes, redactTreeNode, TEXT_CAP } from './redact-node.js';
import type { RedactableTreeNode } from './types.js';

function textNode(text: string): RedactableTreeNode {
  return { type: 'text', text, isVisible: true, parent: null, children: [] };
}

function elementNode(
  attributes: Record<string, string>,
  children: RedactableTreeNode[] = [],
): RedactableTreeNode {
  return { type: 'element', tagName: 'input', attributes, isVisible: true, parent: null, children };
}

describe('redact-node — parity with the suggest-mode path (spec §6.3, §13.1)', () => {
  // The same input string must redact identically through suggest mode
  // (redactText) and the auto-mode per-node path.
  const PII_TABLE = [
    'contact jane.doe@example.com now',
    'card 4111 1111 1111 1111 ok',
    'token eyJhbGciOi.eyJzdWIi.SflKxwRJ',
    'Bearer abcdefghijklmnopqrstuvwxyz0123456789',
    'apiKey: sk_live_abcdef',
    'Release date is required',
  ];

  it.each(PII_TABLE)('text node parity: %s', (input) => {
    const node = redactTreeNode(textNode(input));
    expect(node.text).toBe(capText(redactText(input)));
  });

  it('attribute values are redacted with the same tokens', () => {
    const node = redactTreeNode(
      elementNode({ title: 'mail jane.doe@example.com', name: 'plain-field' }),
    );
    expect(node.attributes?.title).toBe(redactText('mail jane.doe@example.com'));
    expect(node.attributes?.title).toContain('[EMAIL]');
  });

  it('caps single text nodes at 120 chars', () => {
    const long = 'a'.repeat(500);
    const node = redactTreeNode(textNode(long));
    expect(node.text?.length).toBeLessThanOrEqual(TEXT_CAP + 3);
  });
});

describe('redact-node — secret fields never leak (spec §6.3)', () => {
  it('password input: value replaced, descendant text blanked', () => {
    const child = textNode('hunter2-visible-somehow');
    const node = redactTreeNode(
      elementNode({ type: 'password', name: 'password', value: 'hunter2' }, [child]),
    );
    expect(node.attributes?.value).toBe(REDACTED);
    expect(child.text).toBe('');
  });

  it('detects secrets by autocomplete and name/id (same detector as suggest mode)', () => {
    expect(isSecretAttributes({ autocomplete: 'cc-number' })).toBe(true);
    expect(isSecretAttributes({ autocomplete: 'one-time-code' })).toBe(true);
    expect(isSecretAttributes({ name: 'apiKey' })).toBe(true);
    expect(isSecretAttributes({ id: 'user_token' })).toBe(true);
    expect(isSecretAttributes({ type: 'text', name: 'supplier' })).toBe(false);
  });

  it('non-secret value attributes keep their (redacted) value', () => {
    const node = redactTreeNode(elementNode({ type: 'text', name: 'supplier', value: 'ACME' }));
    expect(node.attributes?.value).toBe('ACME');
  });
});
