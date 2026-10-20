// SPDX-License-Identifier: AGPL-3.0-only
//
// Realtime judges a private join by the `access_token` in its `phx_join`
// payload; without one it sees only the publishable key and refuses. The
// pinned client pushes a channel's first join before it asks the
// `accessToken` callback, so the carriage sets the login's token on the client
// before joining (#1668). The fake Realtime server here refuses any private
// join whose payload carries no token or a different one, the way the hosted
// project did on 15 Oct, and admits the login's own.

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realtimeCarriage } from '../../packages/core-custody/src/index.ts';

const TOPIC =
  'carry:0b6f2a8e-1c3d-4e5f-8a9b-0c1d2e3f4a5b:call:7d2c9e41-5a6b-4c7d-8e9f-a0b1c2d3e4f5';
const LOGIN_TOKEN = 'header.e30.login-one';
const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

type Message = [string | null, string | null, string, string, Record<string, unknown>];

// One unmasked server frame (RFC 6455): text, or close with an empty body.
function frame(opcode: number, body: Buffer): Buffer {
  const length = body.length;
  const head =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);
  return Buffer.concat([head, body]);
}

// Reads whole masked client frames off the front of `buffer`, returning them
// and the bytes of any frame still arriving.
function readFrames(buffer: Buffer): { frames: { opcode: number; body: Buffer }[]; rest: Buffer } {
  const frames: { opcode: number; body: Buffer }[] = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset]! & 0x0f;
    let length = buffer[offset + 1]! & 0x7f;
    let start = offset + 2;
    if (length === 126) {
      if (buffer.length < start + 2) break;
      length = buffer.readUInt16BE(start);
      start += 2;
    } else if (length === 127) {
      if (buffer.length < start + 8) break;
      length = Number(buffer.readBigUInt64BE(start));
      start += 8;
    }
    if (buffer.length < start + 4 + length) break;
    const mask = buffer.subarray(start, start + 4);
    const body = Buffer.from(buffer.subarray(start + 4, start + 4 + length));
    for (let index = 0; index < body.length; index += 1) body[index]! ^= mask[index % 4]!;
    frames.push({ opcode, body });
    offset = start + 4 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

// Answers one upgraded socket as Realtime would: heartbeats are acknowledged,
// and a join is admitted only when its payload carries the login's token.
function answerAsRealtime(key: string, socket: Duplex, joins: Record<string, unknown>[]): void {
  const accept = createHash('sha1').update(`${key}${HANDSHAKE_GUID}`).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const reply = (message: Message, status: 'ok' | 'error', response: object): void => {
    const [joinRef, ref, topic] = message;
    const text = JSON.stringify([joinRef, ref, topic, 'phx_reply', { status, response }]);
    socket.write(frame(0x1, Buffer.from(text)));
  };
  let pending: Buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    const { frames, rest } = readFrames(Buffer.concat([pending, chunk]));
    pending = rest;
    for (const { opcode, body } of frames) {
      if (opcode === 0x8) {
        socket.end(frame(0x8, Buffer.alloc(0)));
        return;
      }
      if (opcode !== 0x1) continue;
      const message = JSON.parse(body.toString('utf8')) as Message;
      const [, , topic, event, payload] = message;
      if (topic === 'phoenix' && event === 'heartbeat') reply(message, 'ok', {});
      if (event !== 'phx_join') continue;
      joins.push(payload);
      const admitted = payload['access_token'] === LOGIN_TOKEN;
      reply(message, admitted ? 'ok' : 'error', admitted ? {} : { reason: 'Unauthorized' });
    }
  });
}

describe('a Realtime join of a private topic', () => {
  let server: Server;
  let url = '';
  const joins: Record<string, unknown>[] = [];
  const sockets = new Set<Duplex>();

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(426).end();
    });
    server.on('upgrade', (request, socket: Duplex) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      answerAsRealtime(String(request.headers['sec-websocket-key']), socket, joins);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    url = `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}/realtime/v1`;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("carries the login's token on its first join, so Realtime admits it", async () => {
    joins.length = 0;
    const carriage = realtimeCarriage({ url, apiKey: 'publishable-test', joinTimeoutMs: 1_500 });
    const joined = await carriage.join(TOPIC, LOGIN_TOKEN);
    expect(joins[0]?.['access_token']).toBe(LOGIN_TOKEN);
    expect(joined.ok).toBe(true);
    if (joined.ok) await joined.line.leave();
  }, 15_000);
});
