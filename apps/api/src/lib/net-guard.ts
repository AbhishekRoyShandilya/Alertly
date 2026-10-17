import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { validationError } from './errors';

/**
 * SSRF (Server-Side Request Forgery) protection.
 * A webhook URL comes from the user. Without checks, someone could register
 * http://169.254.169.254/ (cloud metadata, often holding credentials) or http://localhost:3306
 * and make our server call internal systems for them.
 */
const blocked = new BlockList();
// IPv4
blocked.addSubnet('0.0.0.0', 8, 'ipv4'); //        "this network"
blocked.addSubnet('10.0.0.0', 8, 'ipv4'); //       private
blocked.addSubnet('100.64.0.0', 10, 'ipv4'); //    carrier-grade NAT
blocked.addSubnet('127.0.0.0', 8, 'ipv4'); //      loopback
blocked.addSubnet('169.254.0.0', 16, 'ipv4'); //   link-local (cloud metadata lives here)
blocked.addSubnet('172.16.0.0', 12, 'ipv4'); //    private
blocked.addSubnet('192.0.0.0', 24, 'ipv4'); //     IETF protocol assignments
blocked.addSubnet('192.168.0.0', 16, 'ipv4'); //   private
blocked.addSubnet('198.18.0.0', 15, 'ipv4'); //    benchmarking
blocked.addSubnet('224.0.0.0', 4, 'ipv4'); //      multicast
blocked.addSubnet('240.0.0.0', 4, 'ipv4'); //      reserved + broadcast
// IPv6. Note: BlockList automatically checks IPv4-mapped addresses (::ffff:127.0.0.1) against
// the IPv4 rules above, so they need no rule of their own. (A '::ffff:0:0/96' rule would
// actually block every IPv4 address, because the mapping works in both directions.)
blocked.addAddress('::', 'ipv6'); //               unspecified
blocked.addAddress('::1', 'ipv6'); //              loopback
blocked.addSubnet('64:ff9b::', 96, 'ipv6'); //     NAT64: embeds an IPv4 address, could reach private ones
blocked.addSubnet('fc00::', 7, 'ipv6'); //         unique local (private)
blocked.addSubnet('fe80::', 10, 'ipv6'); //        link-local
blocked.addSubnet('ff00::', 8, 'ipv6'); //         multicast

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) return blocked.check(ip, 'ipv6');
  return true; // not an IP at all: refuse
}

export interface GuardOptions {
  allowPrivate: boolean;
  requireHttps: boolean;
  lookup?: (host: string) => Promise<LookupAddress[]>;
}

const defaultLookup = (host: string) => dnsLookup(host, { all: true, verbatim: true });

/**
 * Validates a webhook URL at save time. Rejects non-http(s), plain http in production,
 * and any hostname that resolves to a private/loopback/link-local address.
 * The sender checks again at connection time (see guardedLookup), because DNS answers can
 * change after the URL was saved ("DNS rebinding").
 */
export async function assertPublicHttpUrl(raw: string, opts: GuardOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw validationError('config.url: not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw validationError('config.url: only http and https are allowed');
  }
  if (opts.requireHttps && url.protocol !== 'https:') {
    throw validationError('config.url: https is required');
  }
  if (url.username || url.password) {
    throw validationError('config.url: credentials in the URL are not allowed');
  }
  if (opts.allowPrivate) return url;

  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  let addresses: LookupAddress[];
  if (isIP(host)) {
    addresses = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addresses = await (opts.lookup ?? defaultLookup)(host);
    } catch {
      throw validationError(`config.url: cannot resolve host "${host}"`);
    }
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw validationError('config.url: private, loopback and link-local addresses are not allowed');
  }
  return url;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A drop-in replacement for dns.lookup, passed to http.request({ lookup }).
 * The IP is checked at the moment the socket connects, so there is no gap between
 * "we checked the address" and "we connected to it" for an attacker to exploit.
 */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    dnsLookup(hostname, { all: true, verbatim: true })
      .then((addrs) => {
        const bad =
          !allowPrivate && (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address)));
        if (bad) {
          const err: NodeJS.ErrnoException = new Error(`Blocked private address for ${hostname}`);
          err.code = 'EBLOCKED';
          callback(err, []);
          return;
        }
        if (options.all) callback(null, addrs);
        else callback(null, addrs[0]!.address, addrs[0]!.family);
      })
      .catch((err: NodeJS.ErrnoException) => callback(err, []));
  };
}
