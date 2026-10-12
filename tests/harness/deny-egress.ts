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

type Handle = Methods & Record<symbol, unknown>;

/** The TCP handle class every connect reaches, beneath `Socket.prototype.connect`. */
const TCP_HANDLE = (
  process as unknown as { binding(name: 'tcp_wrap'): { TCP: { prototype: Methods } } }
).binding('tcp_wrap').TCP.prototype;

/**
 * Swap the handle's connects: a tool holding `Socket.prototype.connect` from
 * before the guard still reaches these, and its socket ends with the refusal.
 */
function denyHandleConnects(refuse: (what: string) => Error): () => void {
  const saved = (['connect', 'connect6'] as const).map((name) => {
    const original = TCP_HANDLE[name];
    TCP_HANDLE[name] = function denied(
      this: Handle,
      _request: unknown,
      _address: unknown,
      port: unknown,
    ): number {
      const error = refuse(`socket ${String(port)}`);
      const owner = Object.getOwnPropertySymbols(this).find(
        (symbol) => symbol.description === 'owner_symbol',
      );
      const socket = owner === undefined ? undefined : (this[owner] as Socket | undefined);
      if (socket === undefined) throw error;
      process.nextTick(() => socket.destroy(error));
      return 0;
    };
    return () => {
      TCP_HANDLE[name] = original;
    };
  });
  return () => {
    for (const restore of saved) restore();
  };
}

export interface EgressGuard {
  readonly attempts: readonly string[];
  release(): void;
}

/** The guards held now, last taken last: a refusal is recorded on the last. */
const held: string[][] = [];
/** Swaps every way out but the TCP handle's back to the one from before the first guard held now. */
let restore: (() => void) | undefined;
/** Swaps the TCP handle's connects back; it outlives `restore` by one turn. */
let restoreHandles: (() => void) | undefined;
/**
 * The guard released last, while the handle's connects stay refused: a connect
 * started under it reaches the handle a tick later (`net` queues it on
 * `process.nextTick`) and is refused and recorded there.
 */
let lingering: { readonly attempts: string[]; readonly turn: NodeJS.Immediate } | undefined;

/**
 * Refuse egress until `release`. Guards may overlap and be released in any
 * order: the ways out are swapped once, when the first is taken, and back
 * once, when the last held is released.
 */
export function denyEgress(): EgressGuard {
  const attempts: string[] = [];
  if (held.length === 0) restore = denyAll();
  if (lingering === undefined) restoreHandles ??= denyHandleConnects(refuse);
  else clearImmediate(lingering.turn);
  lingering = undefined;
  held.push(attempts);
  return {
    attempts,
    release: () => {
      const at = held.indexOf(attempts);
      if (at === -1) return;
      held.splice(at, 1);
      if (held.length > 0) return;
      restore?.();
      restore = undefined;
      lingering = {
        attempts,
        turn: setImmediate(() => {
          lingering = undefined;
          restoreHandles?.();
          restoreHandles = undefined;
        }),
      };
    },
  };
}

const refuse = (what: string): Error => {
  (held.at(-1) ?? lingering?.attempts)?.push(what);
  return new Error(`egress denied: ${what}`);
};

function denyAll(): () => void {
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
  return () => {
    Socket.prototype.connect = connect;
    dns.lookup = lookup;
    dns.promises.lookup = promised;
    globalThis.fetch = fetched;
    dgram.Socket.prototype.send = send;
    resolves();
  };
}
