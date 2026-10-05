// SPDX-License-Identifier: AGPL-3.0-only
//
// The preamble of docs/plan/sandbox-contract.md: a reply from our own pinned
// daemon is parsed with P1's parser and read for the keys a line names;
// `_ping`'s body is exactly `OK`, a 204 has no body, and the attach stream is
// read only as Docker's multiplexed frames of stream 1 or 2. A reply that
// breaks these rules is `internal`. Stdout past its cap is refused; stderr
// past 64 KiB is discarded, never refused.

import { expect, it } from 'vitest';
import { AttachFrames } from '../../packages/core-sandbox/src/attach-frames.ts';
import {
  readContainerCount,
  readContainerIds,
  readCreatedId,
  readNoContent,
  readOomKilled,
  readPing,
  readWaitStatus,
} from '../../packages/core-sandbox/src/daemon-reply.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const ID = 'c0ffee'.repeat(10) + 'c0ff';
const frame = (stream: number, payload: Uint8Array, reserved = 0): Uint8Array => {
  const out = new Uint8Array(8 + payload.length);
  out[0] = stream;
  out[1] = reserved;
  new DataView(out.buffer).setUint32(4, payload.length);
  out.set(payload, 8);
  return out;
};
const joined = (blocks: readonly Uint8Array[]): string => Buffer.concat(blocks).toString('utf8');
const internal = { ok: false, reason: 'internal' };

it('reads _ping only as 200 with the body OK', () => {
  expect(readPing(200, bytes('OK'))).toMatchObject({ ok: true });
  expect(readPing(200, bytes('OK\n'))).toMatchObject(internal);
  expect(readPing(200, bytes('ok'))).toMatchObject(internal);
  expect(readPing(200, bytes('OX'))).toMatchObject(internal);
  expect(readPing(200, bytes('XK'))).toMatchObject(internal);
  expect(readPing(500, bytes('OK'))).toMatchObject(internal);
});

it('reads a 204 only with no body', () => {
  expect(readNoContent(204, new Uint8Array())).toMatchObject({ ok: true });
  expect(readNoContent(204, bytes('{}'))).toMatchObject(internal);
  expect(readNoContent(200, new Uint8Array())).toMatchObject(internal);
});

it('reads the created id, ignoring other keys, and only as 64 lowercase hex', () => {
  expect(readCreatedId(bytes(`{"Id":"${ID}","Warnings":[]}`))).toEqual({ ok: true, id: ID });
  expect(readCreatedId(bytes(`{"Id":"${ID.toUpperCase()}"}`))).toMatchObject(internal);
  expect(readCreatedId(bytes(`{"Id":"${ID.slice(1)}"}`))).toMatchObject(internal);
  expect(readCreatedId(bytes(`{"Id":"${ID}","Id":"${ID}"}`))).toMatchObject(internal);
});

it('reads the wait status code as a whole number, and nothing else of the reply', () => {
  expect(readWaitStatus(bytes('{"StatusCode":137,"Error":null}'))).toEqual({
    ok: true,
    statusCode: 137,
  });
  expect(readWaitStatus(bytes('{"StatusCode":"137"}'))).toMatchObject(internal);
  expect(readWaitStatus(bytes('{"StatusCode":1.5}'))).toMatchObject(internal);
  expect(readWaitStatus(bytes('{"StatusCode":-1}'))).toMatchObject(internal);
  expect(readWaitStatus(bytes('{}'))).toMatchObject(internal);
});

it('reads State.OOMKilled as a boolean only', () => {
  expect(readOomKilled(bytes('{"State":{"OOMKilled":true,"Status":"exited"}}'))).toEqual({
    ok: true,
    oomKilled: true,
  });
  expect(readOomKilled(bytes('{"State":{"OOMKilled":false}}'))).toEqual({
    ok: true,
    oomKilled: false,
  });
  expect(readOomKilled(bytes('{"State":{"OOMKilled":"false"}}'))).toMatchObject(internal);
  expect(readOomKilled(bytes('{"State":{}}'))).toMatchObject(internal);
  expect(readOomKilled(bytes('{"State":null}'))).toMatchObject(internal);
});

it('reads the container list as an array of objects with full ids', () => {
  expect(readContainerIds(bytes(`[{"Id":"${ID}","Names":["/x"]}]`))).toEqual({
    ok: true,
    ids: [ID],
  });
  expect(readContainerIds(bytes('[]'))).toEqual({ ok: true, ids: [] });
  expect(readContainerIds(bytes(`[{"Id":"${ID.slice(0, 12)}"}]`))).toMatchObject(internal);
  expect(readContainerIds(bytes(`{"Id":"${ID}"}`))).toMatchObject(internal);
  expect(readContainerIds(bytes(`["${ID}"]`))).toMatchObject(internal);
});

it('reads the container count from info as a whole number at or above zero', () => {
  expect(readContainerCount(bytes('{"Containers":0,"Images":3}'))).toEqual({
    ok: true,
    containers: 0,
  });
  expect(readContainerCount(bytes('{"Containers":2}'))).toEqual({ ok: true, containers: 2 });
  expect(readContainerCount(bytes('{"Containers":-1}'))).toMatchObject(internal);
  expect(readContainerCount(bytes('{"Containers":"0"}'))).toMatchObject(internal);
  expect(readContainerCount(bytes('{'))).toMatchObject(internal);
});

it.each([
  ['a duplicate key', `{"State":{"OOMKilled":false,"OOMKilled":true}}`],
  [
    'a reply deeper than 32',
    `{"State":{"OOMKilled":false},"x":${'['.repeat(32)}${']'.repeat(32)}}`,
  ],
])('treats %s in any reply as a daemon fault', (_name, text) => {
  expect(readOomKilled(bytes(text))).toMatchObject(internal);
});

it('treats a reply over 1 MiB as a daemon fault', () => {
  const big = `{"StatusCode":0,"pad":"${'a'.repeat(1024 * 1024)}"}`;
  expect(readWaitStatus(bytes(big))).toMatchObject(internal);
});

it('splits stdout and stderr across chunk boundaries anywhere', () => {
  const stream = new Uint8Array([
    ...frame(1, bytes('dist')),
    ...frame(2, bytes('warn')),
    ...frame(1, bytes('/x')),
  ]);
  for (let cut = 0; cut <= stream.length; cut += 1) {
    const frames = new AttachFrames(1024);
    frames.push(stream.slice(0, cut), stream.slice(cut));
    const end = frames.end();
    expect(end).toMatchObject({ ok: true, stderrDiscarded: 0 });
    if (!end.ok) return;
    expect(joined(end.stdout)).toBe('dist/x');
    expect(new TextDecoder().decode(end.stderr)).toBe('warn');
  }
});

it('treats a frame of stream 0 as a daemon fault', () => {
  const frames = new AttachFrames(1024);
  frames.push(frame(0, bytes('in')));
  expect(frames.end()).toMatchObject({ ok: false, reason: 'internal' });
});

it.each([3, 255])('treats a frame of stream %i as a daemon fault', (stream) => {
  const frames = new AttachFrames(1024);
  frames.push(frame(stream, bytes('x')));
  expect(frames.end()).toMatchObject({ ok: false, reason: 'internal' });
});

it.each([1, 2, 3])('treats a non-zero reserved header byte %i as a daemon fault', (at) => {
  const frames = new AttachFrames(1024);
  const bad = frame(1, bytes('x'));
  bad[at] = 1;
  frames.push(bad);
  expect(frames.end()).toMatchObject({ ok: false, reason: 'internal' });
});

it('treats a stream that ends inside a frame as a daemon fault', () => {
  const frames = new AttachFrames(1024);
  frames.push(frame(1, bytes('abcdef')).slice(0, 10));
  expect(frames.end()).toMatchObject({ ok: false, reason: 'internal' });
});

it('takes stdout up to its cap exactly and refuses one byte more as output refused', () => {
  const at = new AttachFrames(4);
  at.push(frame(1, bytes('abcd')));
  expect(at.end()).toMatchObject({ ok: true });
  const over = new AttachFrames(4);
  over.push(frame(1, bytes('ab')), frame(1, bytes('cde')));
  expect(over.end()).toMatchObject({ ok: false, reason: 'output refused' });
});

it('keeps the first 64 KiB of stderr and discards the rest without refusing', () => {
  const frames = new AttachFrames(16);
  frames.push(frame(2, new Uint8Array(64 * 1024 + 10).fill(0x61)), frame(1, bytes('ok')));
  const end = frames.end();
  expect(end).toMatchObject({ ok: true, stderrDiscarded: 10 });
  if (!end.ok) return;
  expect(end.stderr.length).toBe(64 * 1024);
  expect(joined(end.stdout)).toBe('ok');
});

it('keeps stdout in blocks sized by the bytes kept, never one per frame', () => {
  const frames = new AttachFrames(2 * 1024 * 1024);
  const one = frame(1, bytes('x'));
  const many = new Uint8Array(one.length * 100_000);
  for (let i = 0; i < 100_000; i += 1) many.set(one, i * one.length);
  frames.push(many);
  const end = frames.end();
  expect(end.ok).toBe(true);
  if (!end.ok) return;
  expect(end.stdout).toHaveLength(1);
  expect(end.stdout[0]?.length).toBe(100_000);
});

it('treats a stream that ends inside a frame header as a daemon fault', () => {
  const frames = new AttachFrames(1024);
  frames.push(frame(1, bytes('ok')), frame(1, bytes('x')).slice(0, 4));
  expect(frames.end()).toMatchObject({ ok: false, reason: 'internal' });
});

it('takes an empty frame, last or not, as a valid frame', () => {
  const frames = new AttachFrames(1024);
  frames.push(frame(1, bytes('ok')), frame(2, new Uint8Array()), frame(1, new Uint8Array()));
  const end = frames.end();
  expect(end).toMatchObject({ ok: true });
  if (!end.ok) return;
  expect(joined(end.stdout)).toBe('ok');
});

it('treats a reply that is null, not an object, as a daemon fault without throwing', () => {
  expect(readCreatedId(bytes('null'))).toMatchObject(internal);
  expect(readOomKilled(bytes('null'))).toMatchObject(internal);
});

it('keeps an output refusal when a bad frame follows it', () => {
  const frames = new AttachFrames(1);
  frames.push(frame(1, bytes('ab')), frame(0, bytes('x')), frame(1, bytes('c')));
  expect(frames.end()).toMatchObject({ ok: false, reason: 'output refused' });
  const after = new AttachFrames(1);
  after.push(frame(1, bytes('ab')), frame(2, bytes('y')), frame(0, bytes('x')));
  expect(after.end()).toMatchObject({ ok: false, reason: 'output refused' });
});

it('treats an id given as a list as a daemon fault', () => {
  expect(readCreatedId(bytes(`{"Id":["${ID}"]}`))).toMatchObject(internal);
  expect(readContainerIds(bytes(`[{"Id":["${ID}"]}]`))).toMatchObject(internal);
});
