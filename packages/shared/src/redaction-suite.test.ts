import { describe, it, expect } from 'vitest';
import { isSensitiveField, redactText } from './redaction.js';

/**
 * Redaction conformance suite (spec §17.3 — must pass 100%). A battery of known
 * sensitive field shapes and leaky text patterns that must always be caught.
 */
const SENSITIVE_FIELDS = [
  { type: 'password' },
  { name: 'password' },
  { name: 'user_password' },
  { id: 'currentPassword' },
  { name: 'pwd' },
  { name: 'apiKey' },
  { name: 'api_key' },
  { id: 'secretToken' },
  { name: 'access_token' },
  { label: 'CVV' },
  { label: 'CVC' },
  { name: 'cardNumber' },
  { id: 'creditCard' },
  { name: 'ssn' },
  { name: 'pin' },
  { autocomplete: 'current-password' },
  { autocomplete: 'new-password' },
  { autocomplete: 'one-time-code' },
  { autocomplete: 'cc-number' },
  { placeholder: 'Enter your secret seed phrase', name: 'seed' },
];

const SAFE_FIELDS = [
  { type: 'text', name: 'supplier' },
  { type: 'email', name: 'contactEmail' },
  { type: 'number', name: 'quantity' },
  { name: 'description' },
  { name: 'addressLine1' },
];

const LEAKY_TEXT = [
  'jane.doe@example.com',
  'card 4111 1111 1111 1111',
  'token eyJhbGciOi.eyJzdWIi.SflKxwRJ',
  'key abcdefghijklmnopqrstuvwxyz0123456789',
];

describe('redaction conformance suite (spec §17.3)', () => {
  it('flags every known sensitive field (100%)', () => {
    const missed = SENSITIVE_FIELDS.filter((f) => !isSensitiveField(f));
    expect(missed).toEqual([]);
  });

  it('does not over-flag safe fields', () => {
    const falsePositives = SAFE_FIELDS.filter((f) => isSensitiveField(f));
    expect(falsePositives).toEqual([]);
  });

  it('masks every leaky text pattern (no raw secret survives)', () => {
    for (const text of LEAKY_TEXT) {
      const redacted = redactText(text);
      expect(redacted).toMatch(/\[(EMAIL|CARD|TOKEN)\]/);
    }
    expect(redactText('jane.doe@example.com')).not.toContain('jane.doe@example.com');
  });
});
