// SPDX-License-Identifier: AGPL-3.0-only
//
// #2291: the local API (`server.ts`) serves through `@hono/node-server`, which
// replaces the global `Response` with its own class once it starts. The
// platform `fetch` still answers with the native class, so the factor adapter
// reads GoTrue's answers here exactly as the running API does: after `serve`,
// over real HTTP, with no `fetch` injected. GoTrue's enrol is the shape
// v2.192.0 answered on the local stack on 29 October 2026: raw SVG of 321,600
// characters, a 32-character base32 secret and a 143-character URI, chunked.
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createGoTrueFactors } from '../../apps/api/auth/factors.ts';
import { gotrueQrSvg } from './gotrue-qr-svg.ts';

const NativeResponse = globalThis.Response;
const FACTOR = '0b6f3d0e-6c1a-4f7e-9d3a-2a8f5c1e7b40';
const CHALLENGE = '5d2e8a71-3b4c-4e9f-8a6d-1c7b9e0f2a35';
const SECRET = 'MADEUPSECRETMADEUPSECRETMADEUPAB';
const URI = `otpauth://totp/127.0.0.1:55491:ada@alpha.local?algorithm=SHA1&digits=6&issuer=127.0.0.1%3A55491&period=30&secret=${SECRET}`;

/** What the stand-in GoTrue answers to the next enrol; the real shape unless a case changes it. */
let qrCode: unknown = gotrueQrSvg(321_600);

/** JSON as Go's `encoding/json` writes it: `<`, `>` and `&` escaped. */
const goJson = (body: unknown): string =>
  JSON.stringify(body)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');

/** Written in 16 KiB pieces with no content-length, as GoTrue's chunked enrol comes. */
function answer(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
  const text = body === undefined ? '' : goJson(body);
  for (let at = 0; at < text.length; at += 16_384) response.write(text.slice(at, at + 16_384));
  response.end();
}

function gotrue(request: IncomingMessage, response: ServerResponse): void {
  const route = `${request.method} ${request.url}`;
  if (route === 'POST /factors') {
    answer(response, 200, {
      id: FACTOR,
      type: 'totp',
      friendly_name: '',
      totp: { qr_code: qrCode, secret: SECRET, uri: URI },
    });
  } else if (route === `POST /factors/${FACTOR}/challenge`) {
    answer(response, 200, { id: CHALLENGE, type: 'totp', expires_at: 1_793_000_000 });
  } else if (route === `POST /factors/${FACTOR}/verify`) {
    answer(response, 200, { access_token: 'a.b.c', refresh_token: 'refresh', expires_in: 3600 });
  } else if (route === 'POST /logout?scope=local') {
    answer(response, 204);
  } else {
    answer(response, 404, { code: 404, msg: 'not found' });
  }
}

const stub = createServer(gotrue);
let api: ReturnType<typeof serve> | undefined;
let baseUrl = '';

beforeAll(async () => {
  stub.listen(0, '127.0.0.1');
  await once(stub, 'listening');
  baseUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  // As `server.ts` starts the local API.
  api = serve({ fetch: () => new Response('ok'), hostname: '127.0.0.1', port: 0 });
  await once(api, 'listening');
});

afterAll(async () => {
  api?.close();
  stub.close();
  await once(stub, 'close');
});

it('runs where the server has replaced the global Response, as the local API does', () => {
  expect(globalThis.Response).not.toBe(NativeResponse);
});

it("admits GoTrue v2.192.0's enrol answer and hands on the QR as an SVG data URI", async () => {
  qrCode = gotrueQrSvg(321_600);
  const enrolled = await createGoTrueFactors({ baseUrl }).enrol('token');
  expect(enrolled).toMatchObject({
    ok: true,
    value: { factorId: FACTOR, secret: SECRET, uri: URI },
  });
  expect(enrolled.ok && enrolled.value.qrCode.startsWith('data:image/svg+xml;base64,')).toBe(true);
});

it('still refuses a QR that is not raw SVG, naming the factor the provider issued', async () => {
  qrCode = `data:image/svg+xml;utf-8,${gotrueQrSvg(4096)}`;
  expect(await createGoTrueFactors({ baseUrl }).enrol('token')).toEqual({
    ok: false,
    fault: 'malformed',
    strayFactorId: FACTOR,
  });
});

it('proves a code and signs out over the same globals', async () => {
  const factors = createGoTrueFactors({ baseUrl });
  expect(await factors.verify('token', FACTOR, '123456')).toEqual({
    ok: true,
    value: { accessToken: 'a.b.c', refreshToken: 'refresh', expiresIn: 3600 },
  });
  expect(await factors.signOut('token', 'local')).toEqual({ ok: true, value: undefined });
});

it('names the fault when GoTrue cannot be reached, never an empty one', async () => {
  const closed = createServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const gone = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
  closed.close();
  await once(closed, 'close');
  expect(await createGoTrueFactors({ baseUrl: gone }).enrol('token')).toEqual({
    ok: false,
    fault: 'unreachable',
  });
  expect(await createGoTrueFactors({ baseUrl: gone }).signOut('token', 'local')).toEqual({
    ok: false,
    fault: 'unreachable',
  });
});
