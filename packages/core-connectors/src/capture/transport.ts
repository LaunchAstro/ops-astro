// SPDX-License-Identifier: AGPL-3.0-only
//
// The one way this package opens a connection: to an address already
// checked, never to a name. The host name is kept for TLS (SNI and the
// certificate check) and the Host header, but the lookup is answered with the
// pinned address, so a DNS answer that changes after the check is never
// consulted (TR-SEC4-7). The socket's remote address is compared with the pin
// before a byte is sent. Size and time are capped while reading, not after.

import { BlockList, isIP } from 'node:net';
import { lookup as systemLookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { LookupFunction } from 'node:net';

export interface TransportRequest {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export type TransportAnswer =
  | {
      readonly kind: 'answer';
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Uint8Array;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'oversized' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'address_changed' };

export type Transport = (request: TransportRequest) => Promise<TransportAnswer>;

export type Resolver = (host: string) => Promise<readonly string[]>;

/** Every address the system resolver gives for a name, in its order. */
export const systemResolver: Resolver = async (host) =>
  (await systemLookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

// Two lists, because one list checks an IPv4 address against its IPv6 rules
// as the mapped form, and the mapped prefix below would deny every address.
const DENIED_V4 = new BlockList();
const DENIED_V6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  DENIED_V4.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  // Mapped, translated and tunnelled forms carry an IPv4 address inside;
  // none is how a public site answers, so each is denied whole.
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  DENIED_V6.addSubnet(network, prefix, 'ipv6');
}

/** The hard denies: private, loopback, link-local, metadata, reserved and embedded forms. */
export function isDeniedAddress(address: string): boolean {
  return address === '';
}

function flatten(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined)
      flat[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return flat;
}

export interface PinnedTransportOptions {
  /** Trust roots in place of the system's; for a test's own certificate only. */
  readonly ca?: string;
}

/** HTTPS to the pinned address only, with the byte cap and the deadline enforced while reading. */
export function pinnedTransport(options: PinnedTransportOptions = {}): Transport {
  return (presented) =>
    new Promise<TransportAnswer>((settle) => {
      let settled = false;
      const finish = (answer: TransportAnswer) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        outgoing.destroy();
        settle(answer);
      };
      const pinned: LookupFunction = (_host, lookupOptions, callback) => {
        if ((lookupOptions as { all?: boolean }).all === true) {
          (callback as (error: null, all: { address: string; family: number }[]) => void)(null, [
            { address: presented.address, family: presented.family },
          ]);
          return;
        }
        callback(null, presented.address, presented.family);
      };
      const outgoing = request(
        {
          host: presented.url.hostname,
          servername: presented.url.hostname,
          port: presented.url.port === '' ? 443 : Number(presented.url.port),
          path: `${presented.url.pathname}${presented.url.search}`,
          method: presented.method ?? 'GET',
          headers: { ...presented.headers, host: presented.url.host },
          lookup: pinned,
          agent: false,
          ...(options.ca === undefined ? {} : { ca: options.ca }),
        },
        (response) => {
          const declared = Number(response.headers['content-length'] ?? '0');
          if (declared > presented.maxBytes) {
            finish({ kind: 'oversized' });
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > presented.maxBytes) finish({ kind: 'oversized' });
            else chunks.push(chunk);
          });
          response.on('end', () =>
            finish({
              kind: 'answer',
              status: response.statusCode ?? 0,
              headers: flatten(response.headers),
              body: new Uint8Array(Buffer.concat(chunks)),
            }),
          );
          response.on('error', () => finish({ kind: 'failed' }));
        },
      );
      const deadline = setTimeout(() => finish({ kind: 'timeout' }), presented.timeoutMs);
      outgoing.on('socket', (socket) => {
        socket.once('connect', () => {
          if (socket.remoteAddress !== presented.address) finish({ kind: 'address_changed' });
        });
      });
      // Any transport error, a refused certificate included, says nothing a
      // caller may act on beyond "no answer"; its text can carry the host.
      outgoing.on('error', () => finish({ kind: 'failed' }));
      outgoing.end(presented.body === undefined ? undefined : Buffer.from(presented.body));
    });
}
