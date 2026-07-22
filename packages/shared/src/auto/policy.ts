/**
 * Destructive-action policy (auto-test-mode-spec §5.5). Matched by the guard
 * layer against element text + aria-label + title (lowercased) before any
 * click/press-Enter/navigate executes. Configurable per run from the side
 * panel; these defaults ship in shared.
 */

export interface DestructivePolicy {
  /** Matched against element text + aria-label + title, lowercase. */
  patterns: RegExp[];
  /** Matched against navigate targets. */
  urlPatterns: RegExp[];
}

export const DEFAULT_DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\bdelete\b/,
  /\bremove\b/,
  /\bdestroy\b/,
  /\bdeactivate\b/,
  /\barchive\b/,
  /\bpay\b/,
  /\bcharge\b/,
  /\bcheckout\b/,
  /\bplace order\b/,
  /\bbuy\b/,
  /\bpurchase\b/,
  /\bsubmit order\b/,
  /\bconfirm order\b/,
  /\bpublish\b/,
  /\bsend\b/,
  /\bunsubscribe\b/,
  /\bcancel (subscription|account|plan)\b/,
  /\breset\b/,
  /\brevoke\b/,
  /\btransfer\b/,
  /\bwithdraw\b/,
  /\bsign out\b/,
  /\blog ?out\b/,
];
