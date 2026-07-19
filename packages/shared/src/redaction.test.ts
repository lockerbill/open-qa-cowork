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

describe('redactText on integration credentials', () => {
  it('masks a Basic Authorization header', () => {
    // base64 contains + / = which fall outside the generic long-token class.
    expect(redactText('Authorization: Basic cWFAYWNtZS5pbzp0b2sxMjM=')).toBe(
      `Authorization: Basic ${REDACTED}`,
    );
  });

  it('masks an Authorization header however it was serialized', () => {
    expect(redactText('{"authorization":"Bearer abc.def.ghi"}')).toContain(`Bearer ${REDACTED}`);
    expect(redactText('authorization=Basic Zm9vOmJhcg==')).toBe(`authorization=Basic ${REDACTED}`);
  });

  it('masks credential-bearing config keys', () => {
    expect(redactText('{"apiToken":"tok-abc-123"}')).toBe(`{"apiToken":"${REDACTED}"}`);
    expect(redactText('apiKey=sk-live-1234')).toBe(`apiKey=${REDACTED}`);
    expect(redactText('client_secret: hunter2')).toBe(`client_secret: ${REDACTED}`);
  });

  it('does not mask a serialized Jira config’s non-secret fields', () => {
    const out = redactText('{"siteUrl":"https://acme.atlassian.net","projectKey":"QA","apiToken":"tok1"}');
    expect(out).toContain('https://acme.atlassian.net');
    expect(out).toContain('"projectKey":"QA"');
    expect(out).not.toContain('tok1');
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
