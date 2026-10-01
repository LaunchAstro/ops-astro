// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12, part one: the environment rule (TEST.md 4.5), in this process. While
// `denyEgress` holds, every outbound socket, datagram, DNS lookup or resolve
// and fetch is refused and recorded, so the four fakes are shown to need no egress at all. A
// candidate's own throwaway environment (no network but the fakes) is part
// two's; this is the rule the fakes are held to first.

import dgram from 'node:dgram';
import dns from 'node:dns';
import { Socket } from 'node:net';

type Methods = Record<string, unknown>;

/** Every resolver: the module's, the promises API's, and both Resolver classes'. */
const RESOLVERS: readonly (readonly [Methods, boolean])[] = [
  [dns as unknown as Methods, false],
  [dns.promises as unknown as Methods, true],
  [dns.Resolver.prototype as unknown as Methods, false],
  [dns.promises.Resolver.prototype as unknown as Methods, true],
];

/** Swap every `resolve*` and `reverse` on each resolver; the swap back is returned. */
function denyResolves(refuse: (what: string) => Error): () => void {
  const saved = RESOLVERS.flatMap(([target, promised]) =>
    Object.getOwnPropertyNames(target)
      .filter((name) => /^(resolve|reverse)/u.test(name))
      .map((name) => {
        const original = target[name];
        target[name] = promised
          ? async (host: string) => {
              throw await Promise.resolve(refuse(`dns ${host}`));
            }
          : (host: string) => {
              throw refuse(`dns ${host}`);
            };
        return () => {
          target[name] = original;
        };
      }),
  );
  return () => {
    for (const restore of saved) restore();
  };
}

export interface EgressGuard {
  readonly attempts: readonly string[];
  release(): void;
}

export function denyEgress(): EgressGuard {
  const attempts: string[] = [];
  const refuse = (what: string): Error => {
    attempts.push(what);
    return new Error(`egress denied: ${what}`);
  };
  const connect = Socket.prototype.connect;
  const lookup = dns.lookup;
  const promised = dns.promises.lookup;
  const fetched = globalThis.fetch;
  const send = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function denied(...args: unknown[]): void {
    // send(msg, port, ...) or send(msg, offset, length, port, ...).
    throw refuse(`udp ${String(typeof args[2] === 'number' ? args[3] : args[1])}`);
  } as typeof dgram.Socket.prototype.send;
  const resolves = denyResolves(refuse);
  Socket.prototype.connect = function denied(this: Socket, ...args: unknown[]): Socket {
    // `net.connect` hands the socket its arguments already normalised, as one array.
    const target: unknown = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    const port =
      typeof target === 'object' && target !== null ? (target as { port?: unknown }).port : target;
    this.destroy(refuse(`socket ${String(port)}`));
    return this;
  } as typeof Socket.prototype.connect;
  dns.lookup = ((host: string) => {
    throw refuse(`dns ${host}`);
  }) as unknown as typeof dns.lookup;
  dns.promises.lookup = (async (host: string) => {
    throw await Promise.resolve(refuse(`dns ${host}`));
  }) as typeof dns.promises.lookup;
  globalThis.fetch = (async (input: unknown) => {
    throw await Promise.resolve(refuse(`fetch ${String(input)}`));
  }) as typeof fetch;
  return {
    attempts,
    release: () => {
      Socket.prototype.connect = connect;
      dns.lookup = lookup;
      dns.promises.lookup = promised;
      globalThis.fetch = fetched;
      dgram.Socket.prototype.send = send;
      resolves();
    },
  };
}
