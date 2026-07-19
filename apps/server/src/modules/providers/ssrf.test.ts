import { describe, it, expect } from 'vitest';
import { assertSafeProviderUrl, isPrivateOrReservedIp } from './ssrf.js';

describe('isPrivateOrReservedIp', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.0.0.5', true],
    ['172.16.0.1', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true], // cloud metadata
    ['0.0.0.0', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['::1', true],
    ['fe80::1', true],
    ['fd00::1', true],
    ['::ffff:127.0.0.1', true], // v4-mapped loopback
    ['2606:4700:4700::1111', false],
  ])('%s → %s', (ip, expected) => {
    expect(isPrivateOrReservedIp(ip)).toBe(expected);
  });
});

describe('assertSafeProviderUrl (hosted posture, allowPrivate=false)', () => {
  const opts = { allowPrivate: false };

  it('allows a public https IP', async () => {
    await expect(assertSafeProviderUrl('https://8.8.8.8/v1', opts)).resolves.toBeUndefined();
  });

  it.each([
    ['http://8.8.8.8/v1', 'non-https'],
    ['https://127.0.0.1/v1', 'loopback'],
    ['https://169.254.169.254/latest/meta-data', 'metadata'],
    ['https://10.1.2.3/v1', 'private'],
    ['ftp://example.com/v1', 'bad scheme'],
    ['https://user:pass@8.8.8.8/v1', 'embedded credentials'],
    ['not a url', 'malformed'],
  ])('rejects %s (%s)', async (url) => {
    await expect(assertSafeProviderUrl(url, opts)).rejects.toThrow();
  });
});

describe('assertSafeProviderUrl (local posture, allowPrivate=true)', () => {
  const opts = { allowPrivate: true };

  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:1234/v1',
    'https://llm.internal.company/v1',
  ])('allows %s', async (url) => {
    await expect(assertSafeProviderUrl(url, opts)).resolves.toBeUndefined();
  });

  it('still rejects non-http schemes and credentials', async () => {
    await expect(assertSafeProviderUrl('ftp://localhost/v1', opts)).rejects.toThrow();
    await expect(assertSafeProviderUrl('http://u:p@localhost/v1', opts)).rejects.toThrow();
  });
});
