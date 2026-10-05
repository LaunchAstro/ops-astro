// SPDX-License-Identifier: AGPL-3.0-only
//
// How the socket proxy frames one launcher request (docs/plan/sandbox-contract.md,
// P1): a request still arriving asks for more and says how much, a head
// past 8 KiB and a byte past the declared body are refused, lengths and
// content types are fixed per operation, header values are exact, and a
// hostile header line is refused in linear time.

import { expect, it } from 'vitest';
import { type CreateShape, fixedCreateBody } from '../../packages/core-sandbox/src/create-body.ts';
import {
  type ProxyGrammar,
  readProxyRequest,
} from '../../packages/core-sandbox/src/proxy-request.ts';

const V = '/v1.47';
const ID = 'c0ffee'.repeat(10) + 'c0ff';
const IMAGE = `sha256:${'ab'.repeat(32)}`;
const S1: CreateShape = { runClass: 'site.build', env: ['PATH=/bin', 'HOME=/tmp/home'] };
const GRAMMAR: ProxyGrammar = { apiVersion: '1.47', shapes: [S1] };
const ATTACH_QUERY = 'stream=1&stdin=1&stdout=1&stderr=1';

const text = new TextEncoder();
const request = (
  line: string,
  headers: readonly string[] = ['Host: docker'],
  body = '',
): Uint8Array => text.encode(`${line}\r\n${headers.map((h) => `${h}\r\n`).join('')}\r\n${body}`);
const json = (shape: CreateShape, image = IMAGE): string =>
  JSON.stringify(fixedCreateBody(shape, image));
const create = (body: string, extra: readonly string[] = []): Uint8Array =>
  request(
    `POST ${V}/containers/create HTTP/1.1`,
    [
      'Host: docker',
      'Content-Type: application/json',
      `Content-Length: ${text.encode(body).length}`,
      ...extra,
    ],
    body,
  );
const read = (bytes: Uint8Array) => readProxyRequest(bytes, GRAMMAR);

it('asks for more bytes, never refusing, while a head or a create body is still arriving', () => {
  const ping = request(`GET ${V}/_ping HTTP/1.1`);
  expect(read(ping.slice(0, ping.length - 2))).toEqual({ ok: 'more', need: null });
  const whole = create(json(S1));
  expect(read(whole.slice(0, -5))).toEqual({ ok: 'more', need: whole.length });
});

it('refuses a head that runs past 8 KiB with no end', () => {
  const long = text.encode(`GET ${V}/_ping HTTP/1.1\r\nHost: ${'a'.repeat(9000)}`);
  expect(read(long)).toMatchObject({ ok: false, why: 'request line' });
});

it('refuses a complete head longer than 8 KiB', () => {
  const long = request(`GET ${V}/_ping HTTP/1.1`, [`Host: ${'a'.repeat(8200)}`]);
  expect(read(long)).toMatchObject({ ok: false, why: 'request line' });
});

it('refuses a create with a byte after its declared body as a second request', () => {
  expect(read(new Uint8Array([...create(json(S1)), 0x47]))).toMatchObject({
    ok: false,
    why: 'second request',
  });
});

it('refuses a create declaring more than 1 MiB before reading it', () => {
  const head = request(`POST ${V}/containers/create HTTP/1.1`, [
    'Host: docker',
    'Content-Type: application/json',
    'Content-Length: 1048577',
  ]);
  expect(read(head)).toMatchObject({ ok: false, why: 'body' });
});

it('refuses a load whose content type is not a tar archive', () => {
  const head = request(`POST ${V}/images/load?quiet=1 HTTP/1.1`, [
    'Host: docker',
    'Content-Type: application/json',
    'Content-Length: 10',
  ]);
  expect(read(head)).toMatchObject({ ok: false, why: 'body' });
});

it.each([
  [
    'an Upgrade value other than tcp',
    ['Host: docker', 'Connection: Upgrade', 'Upgrade: websocket'],
  ],
  ['a Connection value in another case', ['Host: docker', 'Connection: upgrade', 'Upgrade: tcp']],
])('refuses attach with %s', (_name, headers) => {
  const line = `POST ${V}/containers/${ID}/attach?${ATTACH_QUERY} HTTP/1.1`;
  expect(read(request(line, headers))).toMatchObject({ ok: false, why: 'header' });
});

it.each([
  ['a slash', 'docker/x'],
  ['a user part', 'user@docker'],
  ['a port', 'docker:2375'],
])('refuses a Host value with %s', (_name, host) => {
  expect(read(request(`GET ${V}/_ping HTTP/1.1`, [`Host: ${host}`]))).toMatchObject({
    ok: false,
    why: 'header',
  });
});

it('refuses a header line of thousands of spaces in linear time', () => {
  const bytes = request(`GET ${V}/_ping HTTP/1.1`, [`Host:${' '.repeat(8000)}\u0001`]);
  const started = performance.now();
  for (let i = 0; i < 50; i += 1) expect(read(bytes)).toMatchObject({ ok: false });
  expect(performance.now() - started).toBeLessThan(500);
});

it.each([
  ['a path past the action', `POST ${V}/containers/${ID}/start/x HTTP/1.1`, 'unknown route'],
  ['POST on a health path', `POST ${V}/_ping HTTP/1.1`, 'unknown route'],
  ['DELETE on a health path', `DELETE ${V}/info HTTP/1.1`, 'unknown route'],
  [
    'a delete of a container name',
    `DELETE ${V}/containers/sandbox?force=1 HTTP/1.1`,
    'container id',
  ],
  ['GET on start', `GET ${V}/containers/${ID}/start HTTP/1.1`, 'unknown route'],
  ['POST on inspect', `POST ${V}/containers/${ID}/json HTTP/1.1`, 'unknown route'],
  ['DELETE on image inspect', `DELETE ${V}/images/${IMAGE}/json HTTP/1.1`, 'unknown route'],
  ['POST on image inspect', `POST ${V}/images/${IMAGE}/json HTTP/1.1`, 'unknown route'],
])('refuses %s', (_name, line, why) => {
  expect(read(request(line))).toMatchObject({ ok: false, why });
});

it('refuses a load sent with GET', () => {
  const headers = ['Host: docker', 'Content-Type: application/x-tar', 'Content-Length: 10'];
  expect(read(request(`GET ${V}/images/load?quiet=1 HTTP/1.1`, headers))).toMatchObject({
    ok: false,
    why: 'unknown route',
  });
});

it('refuses a load naming an empty site', () => {
  const headers = ['Host: docker', 'Content-Type: application/x-tar', 'Content-Length: 10'];
  expect(read(request(`POST ${V}/images/load?quiet=1&site= HTTP/1.1`, headers))).toMatchObject({
    ok: false,
    why: 'query',
  });
});

it('refuses an attach that carries a length', () => {
  const line = `POST ${V}/containers/${ID}/attach?stream=1&stdin=1&stdout=1&stderr=1 HTTP/1.1`;
  const headers = ['Host: docker', 'Connection: Upgrade', 'Upgrade: tcp', 'Content-Length: 0'];
  expect(read(request(line, headers))).toMatchObject({ ok: false, why: 'body' });
});

it('refuses a header line with no colon even where it would spell an allowed name', () => {
  expect(read(request(`GET ${V}/_ping HTTP/1.1`, ['Hostx']))).toMatchObject({
    ok: false,
    why: 'header',
  });
});
