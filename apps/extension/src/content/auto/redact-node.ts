/**
 * Per-node redaction for auto-mode observations (auto-test-mode-spec §6.3).
 * Wraps the EXISTING shared detectors (`isSensitiveField`, `redactText`) so
 * the suggest-mode and auto-mode paths redact identically — never a regex
 * pass over an already-serialized string. Passed into the vendored
 * `flatTreeToString` as its `redactNode` seam.
 */
import type { FieldMeta } from '@qa-copilot/shared';
import { isSensitiveField, redactText, REDACTED } from '@qa-copilot/shared';
import type { RedactableTreeNode } from './types.js';

/** Single-text-node cap (§5.1/§6.3; aligns with the vendored serializer's capping). */
export const TEXT_CAP = 120;

export function capText(text: string, max = TEXT_CAP): string {
  return text.length > max ? text.slice(0, max) + '...' : text;
}

function metaFromAttributes(attrs: Record<string, string>): FieldMeta {
  return {
    type: attrs.type,
    name: attrs.name,
    id: attrs.id,
    autocomplete: attrs.autocomplete,
    ariaLabel: attrs['aria-label'],
    placeholder: attrs.placeholder,
  };
}

/** Secret detection from serialized attributes (same detector as suggest mode). */
export function isSecretAttributes(attrs: Record<string, string> | undefined): boolean {
  return attrs ? isSensitiveField(metaFromAttributes(attrs)) : false;
}

function blankDescendantText(node: RedactableTreeNode): void {
  for (const child of node.children) {
    if (child.type === 'text') child.text = '';
    blankDescendantText(child);
  }
}

/**
 * The `redactNode` callback for the vendored serializer. Children are built
 * (and individually redacted) before their parent arrives, so a secret parent
 * can still scrub descendant text that pattern-matching alone would miss.
 */
export function redactTreeNode(node: RedactableTreeNode): RedactableTreeNode {
  if (node.type === 'text') {
    if (node.text) node.text = capText(redactText(node.text));
    return node;
  }
  const attrs = node.attributes;
  if (attrs) {
    if (isSecretAttributes(attrs)) {
      // Secret element: its value is never shown and its text never emitted.
      if (attrs.value !== undefined) attrs.value = REDACTED;
      if (attrs.placeholder !== undefined) attrs.placeholder = capText(redactText(attrs.placeholder));
      blankDescendantText(node);
    }
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value) attrs[key] = redactText(value);
    }
  }
  return node;
}
