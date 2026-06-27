import { describe, it, expect } from 'vitest';
import { isSensitiveField, redactText, redactUrlToPath, REDACTED, redactValue } from './redaction.js';

describe('isSensitiveField (spec §11)', () => {
  it('flags password input type', () => {
    expect(isSensitiveField({ type: 'password' })).toBe(true);
  });
  it('flags by name/id tokens', () => {
    expect(isSensitiveField({ name: 'user_token' })).toBe(true);
    expect(isSensitiveField({ id: 'creditCard' })).toBe(true);
    expect(isSensitiveField({ label: 'CVV' })).toBe(true);
    expect(isSensitiveField({ name: 'apiKey' })).toBe(true);
  });
  it('flags by autocomplete', () => {
    expect(isSensitiveField({ autocomplete: 'one-time-code' })).toBe(true);
    expect(isSensitiveField({ autocomplete: 'cc-number' })).toBe(true);
  });
  it('does not flag ordinary fields', () => {
    expect(isSensitiveField({ type: 'text', name: 'supplier' })).toBe(false);
    expect(isSensitiveField({ type: 'email', name: 'contactEmail' })).toBe(false);
  });
  it('redactValue always returns the sentinel', () => {
    expect(redactValue()).toBe(REDACTED);
  });
});

describe('redactText', () => {
  it('masks emails', () => {
    expect(redactText('contact jane.doe@example.com now')).toBe('contact [EMAIL] now');
  });
  it('masks card-like numbers', () => {
    expect(redactText('card 4111 1111 1111 1111 ok')).toBe('card [CARD] ok');
  });
  it('masks JWTs and long tokens', () => {
    expect(redactText('eyJhbGciOi.eyJzdWIi.SflKxwRJ')).toBe('[TOKEN]');
    expect(redactText('Bearer abcdefghijklmnopqrstuvwxyz0123456789')).toBe('Bearer [TOKEN]');
  });
  it('leaves clean text untouched', () => {
    expect(redactText('Release date is required')).toBe('Release date is required');
  });
});

describe('redactUrlToPath (spec §9.5)', () => {
  it('strips query string', () => {
    expect(redactUrlToPath('https://app.example.com/orders?token=abc&id=5')).toBe('/orders');
  });
  it('redacts secrets embedded in the path', () => {
    expect(redactUrlToPath('https://app.example.com/u/jane.doe@example.com')).toBe('/u/[EMAIL]');
  });
});
