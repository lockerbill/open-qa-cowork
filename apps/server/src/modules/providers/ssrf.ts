import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { ApiError } from '../../http/errors.js';

/**
 * SSRF guard for user-supplied provider base URLs. A workspace admin controls
 * `baseUrl`, and the gateway makes server-side requests to it (validate +
 * bug-report generation, whose response is returned to the caller). Without this
 * check an admin could point the server at cloud metadata or internal services.
 *
 * Local/internal LLM endpoints (LM Studio, Ollama, vLLM, internal gateways) are
 * an explicit product feature, so private hosts are permitted only when the
 * deployer opts in via ALLOW_PRIVATE_LLM_HOSTS=true (secure by default).
 */

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

function inV4Range(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base!) & mask);
}

const PRIVATE_V4_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

/** True if an IP literal is loopback, private, link-local, or otherwise reserved. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return PRIVATE_V4_CIDRS.some((cidr) => inV4Range(ip, cidr));
  if (family === 6) {
    const addr = ip.toLowerCase();
    // v4-mapped (::ffff:a.b.c.d) — evaluate the embedded v4 address
    const mapped = addr.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateOrReservedIp(mapped[1]!);
    if (addr === '::1' || addr === '::') return true;
    if (addr.startsWith('fe80') || addr.startsWith('fc') || addr.startsWith('fd')) return true; // link-local + ULA
  }
  return false;
}

/**
 * Validate a provider base URL. Throws ApiError(400) on a disallowed URL.
 * Always rejects non-http(s) schemes and embedded credentials. When
 * `allowPrivate` is false, requires https and rejects hosts that resolve to a
 * private/reserved address.
 */
export async function assertSafeProviderUrl(
  rawUrl: string,
  opts: { allowPrivate: boolean },
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiError(400, 'Invalid base URL', 'invalid_base_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError(400, 'Base URL must use http or https', 'invalid_base_url');
  }
  if (url.username || url.password) {
    throw new ApiError(400, 'Base URL must not contain credentials', 'invalid_base_url');
  }
  if (opts.allowPrivate) return;

  if (url.protocol !== 'https:') {
    throw new ApiError(400, 'Base URL must use https', 'invalid_base_url');
  }
  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  const candidates = net.isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (candidates.length === 0 || candidates.some(isPrivateOrReservedIp)) {
    throw new ApiError(
      400,
      'Base URL resolves to a disallowed (private or reserved) address',
      'disallowed_base_url',
    );
  }
}
