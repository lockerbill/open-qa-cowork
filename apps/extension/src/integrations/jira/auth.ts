/**
 * Jira authentication strategies.
 *
 * v1 is Basic auth with an Atlassian API token (design.md Decision 2). The
 * interface exists so OAuth 3LO can slot in later: 3LO resolves a different
 * base URL (`api.atlassian.com/ex/jira/{cloudId}`) and a Bearer header, and
 * nothing in `JiraClient` should have to change for that.
 */
import type { JiraConfig } from '@qa-copilot/shared';

export interface AuthStrategy {
  /** REST base with no trailing slash, e.g. "https://acme.atlassian.net". */
  getBaseUrl(): string;
  getHeaders(): Record<string, string>;
}

/**
 * Reduce a user-entered site URL to a bare origin: adds a scheme if missing,
 * drops paths and trailing slashes. Returns '' if it cannot be parsed, so
 * callers can treat that as "not configured". Also the value handed to
 * `chrome.permissions.request`, so it must be exactly one origin.
 */
export function normalizeSiteUrl(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    // Require a dotted host: it rejects typos like "acme" that would otherwise
    // normalize to a plausible-looking origin and fail only at request time.
    // (Single-label intranet hosts would need revisiting for Jira Data Center.)
    if (!url.hostname.includes('.')) return '';
    return url.origin;
  } catch {
    return '';
  }
}

/**
 * Request host permission for a Jira origin.
 *
 * MUST be called from an extension page during a user gesture:
 * `chrome.permissions.request` throws "This function must be called during a
 * user gesture" in a service worker, so the background handler only ever
 * *checks* the permission. Resolves true when already granted.
 */
export async function requestJiraOrigin(siteUrl: string): Promise<boolean> {
  const origin = normalizeSiteUrl(siteUrl);
  if (!origin) return false;
  const pattern = `${origin}/*`;
  if (await chrome.permissions.contains({ origins: [pattern] }).catch(() => false)) return true;
  return chrome.permissions.request({ origins: [pattern] }).catch(() => false);
}

/** UTF-8 safe base64 — `btoa` alone throws on anything outside Latin-1. */
function base64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class BasicTokenAuth implements AuthStrategy {
  private readonly baseUrl: string;
  private readonly credentials: string;

  constructor(config: Pick<JiraConfig, 'siteUrl' | 'email' | 'apiToken'>) {
    this.baseUrl = normalizeSiteUrl(config.siteUrl);
    this.credentials = base64(`${config.email}:${config.apiToken}`);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getHeaders(): Record<string, string> {
    return {
      Authorization: `Basic ${this.credentials}`,
      Accept: 'application/json',
    };
  }
}
