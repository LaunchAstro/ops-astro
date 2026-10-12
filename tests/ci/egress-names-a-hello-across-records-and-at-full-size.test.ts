// SPDX-License-Identifier: AGPL-3.0-only
//
// The egress relay names the host of a TLS hello however the client frames
// it: a hello split across two records, the cut inside its server name, is
// read as one handshake, and a hello whose one record is near the 16 KiB
// record limit is read whole before the relay gives up on it.
/* oxlint-disable unicorn/prefer-event-target */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

type Pair = [string, number];
type EgressModule = {
  serverName: (hello: Buffer) => string | undefined;
  firstBytes: (
    socket: unknown,
    pick: (held: Buffer) => Pair | null,
    done: (pair: Pair | undefined, held: Buffer) => void,
  ) => void;
};
const EGRESS = '../../scripts/ops/egress.mjs';
const { serverName, firstBytes } = (await import(
  /* @vite-ignore */
  EGRESS
)) as EgressModule;

const HOST = 'api.example.test';
const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
const record = (body: Buffer) => Buffer.concat([Buffer.from([0x16, 3, 1]), u16(body.length), body]);

/** A ClientHello's handshake message naming `name`, with `padding` bytes of a padding extension. */
function handshake(name: string, padding = 0): Buffer {
  const host = Buffer.from(name, 'latin1');
  const sni = Buffer.concat([
    u16(0),
    u16(host.length + 5),
    u16(host.length + 3),
    Buffer.from([0]),
    u16(host.length),
    host,
  ]);
  const pad = Buffer.concat([u16(21), u16(padding), Buffer.alloc(padding)]);
  const extensions = padding > 0 ? Buffer.concat([pad, sni]) : sni;
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32, 7),
    Buffer.from([0]),
    u16(2),
    Buffer.from([0x13, 0x01]),
    Buffer.from([1, 0]),
    u16(extensions.length),
    extensions,
  ]);
  return Buffer.concat([Buffer.from([1, 0]), u16(body.length), body]);
}

/** A socket that hands `chunks` to the relay's reader one by one. */
function feed(chunks: Buffer[]): Pair | undefined | 'waiting' {
  const socket = Object.assign(new EventEmitter(), {
    pause: () => {},
    setTimeout: () => {},
    destroy: () => {},
  });
  let named: Pair | undefined | 'waiting' = 'waiting';
  firstBytes(
    socket,
    (held) => {
      const name = serverName(held);
      return name === undefined ? null : [name, 443];
    },
    (pair) => {
      named = pair;
    },
  );
  for (const chunk of chunks) if (named === 'waiting') socket.emit('data', chunk);
  return named;
}

describe('egress relay hello framing', () => {
  it('names a hello split across two records inside its server name', () => {
    const whole = handshake(HOST);
    const cut = whole.length - 4;
    const split = Buffer.concat([record(whole.subarray(0, cut)), record(whole.subarray(cut))]);
    expect(serverName(record(whole)), 'control: one record').toBe(HOST);
    expect(serverName(split), 'the parse ran into the second record').toBe(HOST);
  });

  it('names a hello whose one record is 16,380 bytes', () => {
    const base = handshake(HOST).length;
    const hello = record(handshake(HOST, 16_380 - base - 4));
    expect(hello.length).toBe(5 + 16_380);
    expect(serverName(hello), 'control: read whole').toBe(HOST);
    expect(
      feed([hello.subarray(0, 16_384), hello.subarray(16_384)]),
      'the reader gave up one record header short',
    ).toEqual([HOST, 443]);
  });
});
