import { describe, expect, it } from 'vitest';
import { assertPublicHttpUrl, isPrivateAddress } from '../../src/lib/net-guard';

const strict = { allowPrivate: false, requireHttps: false };
const fakeDns =
  (address: string, family = 4) =>
  async () => [{ address, family }];

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.16.3.4',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ])('%s is blocked', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111'])('%s is public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('assertPublicHttpUrl', () => {
  it.each([
    'http://127.0.0.1/hook',
    'http://10.0.0.5/hook',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]:8080/',
    'http://[::ffff:127.0.0.1]/',
  ])('rejects %s', async (url) => {
    await expect(assertPublicHttpUrl(url, strict)).rejects.toThrow(/not allowed/);
  });

  it('rejects a public-looking hostname that resolves to a private IP', async () => {
    await expect(
      assertPublicHttpUrl('https://evil.example.com/', { ...strict, lookup: fakeDns('10.1.2.3') }),
    ).rejects.toThrow(/not allowed/);
  });

  it('accepts a public https URL', async () => {
    const url = await assertPublicHttpUrl('https://hooks.example.com/alertly', {
      ...strict,
      lookup: fakeDns('93.184.216.34'),
    });
    expect(url.hostname).toBe('hooks.example.com');
  });

  it('rejects other protocols, embedded credentials, and http when https is required', async () => {
    await expect(assertPublicHttpUrl('ftp://example.com/', strict)).rejects.toThrow(/http/);
    await expect(
      assertPublicHttpUrl('https://user:pw@example.com/', {
        ...strict,
        lookup: fakeDns('1.1.1.1'),
      }),
    ).rejects.toThrow(/credentials/);
    await expect(
      assertPublicHttpUrl('http://example.com/', { ...strict, requireHttps: true }),
    ).rejects.toThrow(/https is required/);
  });

  it('allows private targets only when explicitly enabled (dev/test)', async () => {
    await expect(
      assertPublicHttpUrl('http://127.0.0.1:9999/', { allowPrivate: true, requireHttps: false }),
    ).resolves.toBeInstanceOf(URL);
  });
});
