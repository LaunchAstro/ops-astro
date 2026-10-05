// SPDX-License-Identifier: AGPL-3.0-only
//
// P1, P2, P4's request forms, P5's query form and P7 of
// docs/plan/sandbox-contract.md: the socket proxy reads each launcher request
// as a closed grammar and forwards only bytes it rebuilt from the checked
// values. Which ids and images are recorded or pinned is the proxy's state,
// checked after this grammar; here an id and an image only need their form.

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
const UPGRADE = ['Connection: Upgrade', 'Upgrade: tcp'];

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
it.each([
  ['another API version', `GET /v1.46/_ping HTTP/1.1`],
  ['no API version', `GET /_ping HTTP/1.1`],
])('refuses %s', (_name, line) => {
  expect(read(request(line))).toMatchObject({
    ok: false,
    reason: 'proxy refused',
    why: 'version',
  });
});

it.each([
  ['percent-encoding in the path', `GET ${V}/%5fping HTTP/1.1`],
  ['an encoded dot segment', `GET ${V}/containers/%2e%2e/_ping HTTP/1.1`],
  ['a dot-dot segment', `GET ${V}/containers/../_ping HTTP/1.1`],
  ['a dot segment', `GET ${V}/./_ping HTTP/1.1`],
  ['an empty segment', `GET ${V}//_ping HTTP/1.1`],
])('refuses %s', (_name, line) => {
  expect(read(request(line))).toMatchObject({ ok: false, why: 'path' });
});

it.each([
  ['a query on _ping', `GET ${V}/_ping?x=1 HTTP/1.1`, ['Host: docker']],
  [
    'attach without stderr',
    `POST ${V}/containers/${ID}/attach?stream=1&stdin=1&stdout=1 HTTP/1.1`,
    ['Host: docker', ...UPGRADE],
  ],
  [
    'attach with logs',
    `POST ${V}/containers/${ID}/attach?${ATTACH_QUERY}&logs=1 HTTP/1.1`,
    ['Host: docker', ...UPGRADE],
  ],
  [
    'attach with a repeated parameter',
    `POST ${V}/containers/${ID}/attach?stream=1&stream=1&stdout=1&stderr=1 HTTP/1.1`,
    ['Host: docker', ...UPGRADE],
  ],
  [
    'a delete with force=true',
    `DELETE ${V}/containers/${ID}?force=true HTTP/1.1`,
    ['Host: docker'],
  ],
  [
    'a delete that also removes volumes',
    `DELETE ${V}/containers/${ID}?force=1&v=1 HTTP/1.1`,
    ['Host: docker'],
  ],
  ['a delete with no force', `DELETE ${V}/containers/${ID} HTTP/1.1`, ['Host: docker']],
  [
    'a wait with a condition',
    `POST ${V}/containers/${ID}/wait?condition=removed HTTP/1.1`,
    ['Host: docker'],
  ],
  [
    'a kill with a signal',
    `POST ${V}/containers/${ID}/kill?signal=SIGTERM HTTP/1.1`,
    ['Host: docker'],
  ],
  ['a create with a name', `POST ${V}/containers/create?name=x HTTP/1.1`, ['Host: docker']],
  [
    'a load with quiet=0',
    `POST ${V}/images/load?quiet=0 HTTP/1.1`,
    ['Host: docker', 'Content-Type: application/x-tar', 'Content-Length: 1'],
  ],
  [
    'a load site in capitals',
    `POST ${V}/images/load?quiet=1&site=Physio HTTP/1.1`,
    ['Host: docker', 'Content-Type: application/x-tar', 'Content-Length: 1'],
  ],
  [
    'a load site of 65 characters',
    `POST ${V}/images/load?quiet=1&site=${'a'.repeat(65)} HTTP/1.1`,
    ['Host: docker', 'Content-Type: application/x-tar', 'Content-Length: 1'],
  ],
  [
    'a percent-encoded load site',
    `POST ${V}/images/load?quiet=1&site=a%2db HTTP/1.1`,
    ['Host: docker', 'Content-Type: application/x-tar', 'Content-Length: 1'],
  ],
])('refuses %s', (_name, line, headers) => {
  expect(read(request(line, headers))).toMatchObject({ ok: false, why: 'query' });
});

it.each([
  ['a registry auth header', ['Host: docker', 'X-Registry-Auth: e30=']],
  ['an authorization header', ['Host: docker', 'Authorization: Basic eDp5']],
  ['a second Host', ['Host: docker', 'Host: other']],
  ['no Host', []],
  ['upgrade headers on a non-attach request', ['Host: docker', ...UPGRADE]],
  ['a folded header line', ['Host: docker', 'Content-Type: a', ' b']],
  ['a header with no colon', ['Host: docker', 'Broken']],
])('refuses %s', (_name, headers) => {
  expect(read(request(`GET ${V}/_ping HTTP/1.1`, headers))).toMatchObject({
    ok: false,
    why: 'header',
  });
});

it('refuses Transfer-Encoding by name', () => {
  const bytes = request(`POST ${V}/containers/create HTTP/1.1`, [
    'Host: docker',
    'Content-Type: application/json',
    'Transfer-Encoding: chunked',
  ]);
  expect(read(bytes)).toMatchObject({ ok: false, why: 'transfer-encoding' });
});

it('refuses attach without its upgrade headers', () => {
  const bytes = request(`POST ${V}/containers/${ID}/attach?${ATTACH_QUERY} HTTP/1.1`);
  expect(read(bytes)).toMatchObject({ ok: false, why: 'header' });
});

it.each([
  [
    'a body on start',
    request(
      `POST ${V}/containers/${ID}/start HTTP/1.1`,
      ['Host: docker', 'Content-Length: 2'],
      '{}',
    ),
  ],
  [
    'a content type on a GET',
    request(`GET ${V}/info HTTP/1.1`, ['Host: docker', 'Content-Type: application/json']),
  ],
  ['a create body shorter than its length', create(json(S1)).slice(0, -5)],
  [
    'a create length that is not digits',
    request(
      `POST ${V}/containers/create HTTP/1.1`,
      ['Host: docker', 'Content-Type: application/json', 'Content-Length: +5'],
      '{}',
    ),
  ],
  [
    'a create with the wrong content type',
    request(
      `POST ${V}/containers/create HTTP/1.1`,
      ['Host: docker', 'Content-Type: text/plain', `Content-Length: ${json(S1).length}`],
      json(S1),
    ),
  ],
])('refuses %s', (_name, bytes) => {
  expect(read(bytes)).toMatchObject({ ok: false, why: 'body' });
});

it('refuses a second request on one connection', () => {
  const ping = request(`GET ${V}/_ping HTTP/1.1`);
  const both = new Uint8Array([...ping, ...ping]);
  expect(read(both)).toMatchObject({ ok: false, why: 'second request' });
});

it.each([
  ['HTTP/1.0', `GET ${V}/_ping HTTP/1.0`],
  ['a lowercase method', `get ${V}/_ping HTTP/1.1`],
  ['PUT', `PUT ${V}/containers/${ID}/archive?path=/ HTTP/1.1`],
  ['an absolute-form target', `GET http://docker${V}/_ping HTTP/1.1`],
])('refuses a request line with %s', (_name, line) => {
  expect(read(request(line))).toMatchObject({ ok: false, reason: 'proxy refused' });
});

it.each([
  ['build', `POST ${V}/build HTTP/1.1`],
  ['session', `POST ${V}/session HTTP/1.1`],
  ['exec', `POST ${V}/containers/${ID}/exec HTTP/1.1`],
  ['commit', `POST ${V}/commit HTTP/1.1`],
  ['archive copy out', `GET ${V}/containers/${ID}/archive HTTP/1.1`],
  ['image pull', `POST ${V}/images/create HTTP/1.1`],
  ['image push', `POST ${V}/images/${IMAGE}/push HTTP/1.1`],
  ['image export', `GET ${V}/images/${IMAGE}/get HTTP/1.1`],
  ['plugins', `GET ${V}/plugins HTTP/1.1`],
  ['networks', `GET ${V}/networks HTTP/1.1`],
  ['volumes', `GET ${V}/volumes HTTP/1.1`],
  ['swarm', `GET ${V}/swarm HTTP/1.1`],
  ['events', `GET ${V}/events HTTP/1.1`],
  ['system prune', `POST ${V}/containers/prune HTTP/1.1`],
  ['the container list, which only the sweep may send', `GET ${V}/containers/json HTTP/1.1`],
  ['container logs', `GET ${V}/containers/${ID}/logs HTTP/1.1`],
])('refuses %s', (_name, line) => {
  expect(read(request(line))).toMatchObject({ ok: false, why: 'unknown route' });
});

it.each([
  ['a container name', 'sandbox'],
  ['a 12-character prefix', ID.slice(0, 12)],
  ['uppercase hex', ID.toUpperCase()],
])('refuses a container named by %s', (_name, id) => {
  expect(read(request(`POST ${V}/containers/${id}/start HTTP/1.1`))).toMatchObject({
    ok: false,
    why: 'container id',
  });
});

it('refuses an image named by tag', () => {
  expect(read(request(`DELETE ${V}/images/node:22 HTTP/1.1`))).toMatchObject({
    ok: false,
    why: 'image id',
  });
});

it('refuses a create body that differs from every allowed shape, and one with a case-folded duplicate key', () => {
  expect(read(create(json({ ...S1, env: ['PATH=/bin'] })))).toMatchObject({
    ok: false,
    why: 'create body',
  });
  const twice = json(S1).replace('{"Image"', `{"image":"${IMAGE}","Image"`);
  expect(read(create(twice))).toMatchObject({ ok: false, why: 'duplicate key' });
});
