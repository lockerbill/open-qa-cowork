/**
 * Sensitive-data detection and masking (spec §11). Two layers:
 *  - `isSensitiveField` decides whether a field's *value* must never be stored.
 *  - `redactText` masks secrets that leak into free text (console msgs, URLs).
 */

export const REDACTED = '[REDACTED]';

export interface FieldMeta {
  /** HTML input type. */
  type?: string;
  name?: string;
  id?: string;
  autocomplete?: string;
  ariaLabel?: string;
  label?: string;
  placeholder?: string;
}

/** Name/label tokens that indicate a secret or PII field. */
const SENSITIVE_NAME = /pass|pwd|secret|token|otp|2fa|mfa|ssn|sin|card|cc-?num|cvv|cvc|credit|pin|auth|api[-_]?key|private[-_]?key|seed|mnemonic/i;

/** autocomplete values that signal sensitive content. */
const SENSITIVE_AUTOCOMPLETE = /current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp/i;

export function isSensitiveField(meta: FieldMeta): boolean {
  if (meta.type && /^(password)$/i.test(meta.type)) return true;
  if (meta.autocomplete && SENSITIVE_AUTOCOMPLETE.test(meta.autocomplete)) return true;
  for (const v of [meta.name, meta.id, meta.ariaLabel, meta.label, meta.placeholder]) {
    if (v && SENSITIVE_NAME.test(v)) return true;
  }
  return false;
}

/** Always returns the redaction sentinel — used for sensitive field values. */
export function redactValue(): string {
  return REDACTED;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 13–19 digit runs (optionally separated by spaces/dashes) — card-like.
// Anchored on digits at both ends so a trailing separator is never consumed.
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
// JWTs and long opaque tokens.
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const LONG_TOKEN = /\b[A-Za-z0-9_-]{32,}\b/g;

/** Mask emails, card numbers, and tokens inside free text. */
export function redactText(text: string): string {
  if (!text) return text;
  return text
    .replace(JWT, '[TOKEN]')
    .replace(EMAIL, '[EMAIL]')
    .replace(CARD, '[CARD]')
    .replace(LONG_TOKEN, '[TOKEN]');
}

/** Strip query string and redact the path of a URL for network evidence (spec §9.5). */
export function redactUrlToPath(rawUrl: string): string {
  try {
    const u = new URL(rawUrl, 'http://placeholder.local');
    return redactText(u.pathname);
  } catch {
    // Not a parseable URL — best-effort: drop everything after `?` then redact.
    const noQuery = rawUrl.split('?')[0] ?? rawUrl;
    return redactText(noQuery);
  }
}
