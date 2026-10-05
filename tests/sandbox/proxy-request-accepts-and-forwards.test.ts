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
  forwardBytes,
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
  ['_ping', 'ping'],
  ['version', 'version'],
  ['info', 'info'],
])('reads GET /%s with no query as %s', (path, kind) => {
  expect(read(request(`GET ${V}/${path} HTTP/1.1`))).toEqual({ ok: true, op: { kind } });
});

it('reads a create whose body equals an allowed fixed shape', () => {
  expect(read(create(json(S1)))).toEqual({
    ok: true,
    op: { kind: 'create', shape: S1, image: IMAGE },
  });
});

it('reads attach with exactly the four stream parameters and the upgrade headers', () => {
  const bytes = request(`POST ${V}/containers/${ID}/attach?${ATTACH_QUERY} HTTP/1.1`, [
    'Host: docker',
    ...UPGRADE,
  ]);
  expect(read(bytes)).toEqual({ ok: true, op: { kind: 'attach', id: ID } });
});

it.each([
  ['POST', 'start', 'start'],
  ['POST', 'wait', 'wait'],
  ['POST', 'kill', 'kill'],
  ['GET', 'json', 'inspect'],
])('reads %s /containers/{id}/%s as %s', (method, action, kind) => {
  expect(read(request(`${method} ${V}/containers/${ID}/${action} HTTP/1.1`))).toEqual({
    ok: true,
    op: { kind, id: ID },
  });
});

it('reads a forced delete of a full id', () => {
  expect(read(request(`DELETE ${V}/containers/${ID}?force=1 HTTP/1.1`))).toEqual({
    ok: true,
    op: { kind: 'delete', id: ID },
  });
});

it('reads both load forms, with the site taken out of what is forwarded', () => {
  const load = (query: string) =>
    read(
      request(`POST ${V}/images/load?${query} HTTP/1.1`, [
        'Host: docker',
        'Content-Type: application/x-tar',
        'Content-Length: 10240',
      ]),
    );
  expect(load('quiet=1')).toEqual({
    ok: true,
    op: { kind: 'load', site: null, contentLength: 10240 },
  });
  const candidate = load('quiet=1&site=physio-north-2');
  expect(candidate).toEqual({
    ok: true,
    op: { kind: 'load', site: 'physio-north-2', contentLength: 10240 },
  });
  if (!candidate.ok) return;
  expect(new TextDecoder().decode(forwardBytes(candidate.op, '1.47'))).toMatch(
    /^POST \/v1\.47\/images\/load\?quiet=1 HTTP\/1\.1\r\n/u,
  );
});

it('reads image inspect and delete of a full image id', () => {
  expect(read(request(`GET ${V}/images/${IMAGE}/json HTTP/1.1`))).toEqual({
    ok: true,
    op: { kind: 'image-inspect', image: IMAGE },
  });
  expect(read(request(`DELETE ${V}/images/${IMAGE} HTTP/1.1`))).toEqual({
    ok: true,
    op: { kind: 'image-delete', image: IMAGE },
  });
});

it('takes header names in any case', () => {
  expect(read(request(`GET ${V}/_ping HTTP/1.1`, ['hOsT: docker']))).toMatchObject({ ok: true });
});

it('forwards a create rebuilt from the checked shape, never the bytes it received', () => {
  const fixed = fixedCreateBody(S1, IMAGE) as Record<string, unknown>;
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(fixed).toReversed()), null, 2);
  const result = read(create(reordered));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const body = json(S1);
  expect(new TextDecoder().decode(forwardBytes(result.op, '1.47'))).toBe(
    `POST /v1.47/containers/create HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
  );
});

it('forwards attach with its fixed query and upgrade headers only', () => {
  expect(new TextDecoder().decode(forwardBytes({ kind: 'attach', id: ID }, '1.47'))).toBe(
    `POST /v1.47/containers/${ID}/attach?${ATTACH_QUERY} HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`,
  );
});

it('forwards a forced delete with nothing but its one parameter', () => {
  expect(new TextDecoder().decode(forwardBytes({ kind: 'delete', id: ID }, '1.47'))).toBe(
    `DELETE /v1.47/containers/${ID}?force=1 HTTP/1.1\r\nHost: docker\r\n\r\n`,
  );
});
