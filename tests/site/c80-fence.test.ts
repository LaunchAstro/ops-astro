// SPDX-License-Identifier: AGPL-3.0-only
//
// C80: the fenced capture (C18-1). Catalogued pages only, its own pool, no
// provider credential, no private network, the hard denies checked on the
// resolved address at every redirect, and every connection pinned to the
// address that was checked.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkPageAllowed,
  fencedFetch,
  isDeniedAddress,
  pinnedTransport,
  type CapturePool,
  type FenceRefusal,
  type Resolver,
  type Transport,
  type TransportRequest,
} from '../../packages/core-connectors/src/index.ts';

const ABOUT = 'https://www.example.com/about';
const SERVICES = 'https://www.example.com/services';
const PUBLIC_V4 = '93.184.215.14';
const OTHER_PUBLIC_V4 = '93.184.215.15';

const POOL: CapturePool = {
  agencyPages: [ABOUT, SERVICES],
  otherPages: ['https://client.example.org/'],
  closedPoolReviews: [],
};

function resolverOf(...answers: string[][]): Resolver & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const resolve = async (host: string) => {
    calls.push(host);
    const answer = answers[Math.min(index, answers.length - 1)] ?? [];
    index += 1;
    return answer;
  };
  return Object.assign(resolve, { calls });
}

type Script = (request: TransportRequest) => Awaited<ReturnType<Transport>>;

function transportOf(script: Script): Transport & { seen: TransportRequest[] } {
  const seen: TransportRequest[] = [];
  const transport = async (request: TransportRequest) => {
    seen.push(request);
    return script(request);
  };
  return Object.assign(transport, { seen });
}

const html = (body: string) => ({
  kind: 'answer' as const,
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body: new TextEncoder().encode(body),
});

describe('C80 capture pool allowlist', () => {
  it('allows the agency catalogued pages and nothing else on that host', () => {
    expect(checkPageAllowed(ABOUT, POOL).ok).toBe(true);
    for (const url of [
      'https://www.example.com/contact',
      'https://www.example.com/about/',
      'https://www.example.com/about?x=1',
      'https://www.example.com/about#top',
      'http://www.example.com/about',
      // Userinfo on the catalogued host, built so it does not read as a mail address.
      `https://user:pw${'@'}www.example.com/about`,
      'https://www.example.com:8443/about',
      'https://www.example.com./about',
      'https://WWW.EXAMPLE.COM/%61bout',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(checkPageAllowed(url, POOL), url).toMatchObject({
        ok: false,
        code: 'CAPTURE_HOST_NOT_CATALOGUED',
      });
    }
  });

  it('refuses another catalogued host until three distinct other-company pool reviews are closed (D17-14)', () => {
    const other = 'https://client.example.org/';
    expect(checkPageAllowed(other, POOL)).toMatchObject({ code: 'CAPTURE_POOL_REVIEWS_OPEN' });
    const two = { ...POOL, closedPoolReviews: ['review-a', 'review-b', 'review-b'] };
    expect(checkPageAllowed(other, two)).toMatchObject({ code: 'CAPTURE_POOL_REVIEWS_OPEN' });
    const three = { ...POOL, closedPoolReviews: ['review-a', 'review-b', 'review-c'] };
    expect(checkPageAllowed(other, three).ok).toBe(true);
  });

  it('sends no credential of any kind and no header the fence did not set', async () => {
    const transport = transportOf(() => html('<p>We walk alongside you.</p>'));
    const result = await fencedFetch(ABOUT, {
      pool: POOL,
      resolve: resolverOf([PUBLIC_V4]),
      transport,
      kind: 'document',
    });
    expect(result.ok).toBe(true);
    const headers = transport.seen[0]?.headers ?? {};
    expect(Object.keys(headers).toSorted()).toEqual(['accept', 'user-agent']);
  });

  it('fetches a stylesheet only from the page host it belongs to', async () => {
    const transport = transportOf(() => ({
      kind: 'answer',
      status: 200,
      headers: { 'content-type': 'text/css' },
      body: new TextEncoder().encode('p{}'),
    }));
    const options = { pool: POOL, resolve: resolverOf([PUBLIC_V4]), transport };
    const own = await fencedFetch('https://www.example.com/_astro/site.css', {
      ...options,
      kind: 'stylesheet',
      page: ABOUT,
    });
    expect(own.ok).toBe(true);
    const foreign = await fencedFetch('https://cdn.example.net/site.css', {
      ...options,
      kind: 'stylesheet',
      page: ABOUT,
    });
    expect(foreign).toMatchObject({ ok: false, code: 'CAPTURE_HOST_NOT_CATALOGUED' });
  });
});

describe('C80 dns rebinding', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::',
  ])('denies %s', (address) => {
    expect(isDeniedAddress(address)).toBe(true);
  });

  it('allows a public address', () => {
    expect(isDeniedAddress(PUBLIC_V4)).toBe(false);
    expect(isDeniedAddress('2606:2800:21f:cb07:6820:80da:af6b:8b2c')).toBe(false);
  });

  it('connects to the address it checked, and never asks DNS again for that hop', async () => {
    const resolve = resolverOf([PUBLIC_V4], ['127.0.0.1']);
    const transport = transportOf(() => html('<p>ok</p>'));
    const result = await fencedFetch(ABOUT, { pool: POOL, resolve, transport, kind: 'document' });
    expect(result.ok).toBe(true);
    expect(resolve.calls).toEqual(['www.example.com']);
    expect(transport.seen.map((seen) => seen.address)).toEqual([PUBLIC_V4]);
  });

  it('refuses an answer that mixes a public and a private address', async () => {
    const transport = transportOf(() => html('<p>ok</p>'));
    const recorded: FenceRefusal[] = [];
    const result = await fencedFetch(ABOUT, {
      pool: POOL,
      resolve: resolverOf([PUBLIC_V4, '10.0.0.5']),
      transport,
      kind: 'document',
      record: (refusal) => recorded.push(refusal),
    });
    expect(result).toMatchObject({ ok: false, code: 'CAPTURE_ADDRESS_DENIED' });
    expect(transport.seen).toHaveLength(0);
    expect(recorded.map((entry) => entry.code)).toEqual(['CAPTURE_ADDRESS_DENIED']);
  });

  it('checks the resolved address again at a redirect, and refuses one that rebinds to a private address', async () => {
    const transport = transportOf((request) =>
      request.url.pathname === '/about'
        ? { kind: 'answer', status: 301, headers: { location: SERVICES }, body: new Uint8Array() }
        : html('<p>ok</p>'),
    );
    const result = await fencedFetch(ABOUT, {
      pool: POOL,
      resolve: resolverOf([PUBLIC_V4], ['169.254.169.254']),
      transport,
      kind: 'document',
    });
    expect(result).toMatchObject({ ok: false, code: 'CAPTURE_ADDRESS_DENIED' });
    expect(transport.seen).toHaveLength(1);
  });

  it('refuses when the socket reached an address other than the one checked', async () => {
    const transport = transportOf(() => ({ kind: 'address_changed' }));
    const result = await fencedFetch(ABOUT, {
      pool: POOL,
      resolve: resolverOf([PUBLIC_V4]),
      transport,
      kind: 'document',
    });
    expect(result).toMatchObject({ ok: false, code: 'CAPTURE_ADDRESS_CHANGED' });
  });

  describe('the production transport', () => {
    let dir = '';
    let server: Server | undefined;
    let port = 0;
    let ca = '';
    const hosts: string[] = [];

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'c80-tls-'));
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'ec',
          '-pkeyopt',
          'ec_paramgen_curve:prime256v1',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=pilot.invalid',
          '-addext',
          'subjectAltName=DNS:pilot.invalid',
          '-keyout',
          join(dir, 'key.pem'),
          '-out',
          join(dir, 'cert.pem'),
        ],
        { stdio: 'ignore' },
      );
      ca = readFileSync(join(dir, 'cert.pem'), 'utf8');
      server = createServer(
        { key: readFileSync(join(dir, 'key.pem')), cert: ca },
        (request, response) => {
          hosts.push(request.headers.host ?? '');
          if (request.url === '/big') {
            response.writeHead(200, { 'content-type': 'text/html' });
            response.end('x'.repeat(4096));
            return;
          }
          if (request.url === '/slow') return;
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<p>pinned</p>');
        },
      );
      await new Promise<void>((done) => server?.listen(0, '127.0.0.1', done));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      server?.closeAllConnections();
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      rmSync(dir, { recursive: true, force: true });
    });

    const request = (
      path: string,
      overrides: Partial<TransportRequest> = {},
    ): TransportRequest => ({
      url: new URL(`https://pilot.invalid:${port}${path}`),
      address: '127.0.0.1',
      family: 4,
      headers: { accept: 'text/html', 'user-agent': 'fence-test' },
      timeoutMs: 2_000,
      maxBytes: 1_024,
      ...overrides,
    });

    it('reaches the pinned address for a name DNS cannot resolve, with SNI and host kept', async () => {
      const answer = await pinnedTransport({ ca })(request('/'));
      expect(answer).toMatchObject({ kind: 'answer', status: 200 });
      if (answer.kind !== 'answer') return;
      expect(new TextDecoder().decode(answer.body)).toBe('<p>pinned</p>');
      expect(hosts.at(-1)).toBe(`pilot.invalid:${port}`);
    });

    it('stops at the byte cap and at the timeout', async () => {
      expect(await pinnedTransport({ ca })(request('/big'))).toEqual({ kind: 'oversized' });
      expect(await pinnedTransport({ ca })(request('/slow', { timeoutMs: 200 }))).toEqual({
        kind: 'timeout',
      });
    });

    it('refuses a certificate the trust roots do not hold', async () => {
      expect(await pinnedTransport()(request('/'))).toEqual({ kind: 'failed' });
    });
  });
});

describe('C80 hostile provider (capture path)', () => {
  const options = (transport: Transport) => ({
    pool: POOL,
    resolve: resolverOf([PUBLIC_V4], [OTHER_PUBLIC_V4]),
    transport,
    kind: 'document' as const,
  });

  it('refuses and records a redirect to an unlisted destination', async () => {
    const recorded: FenceRefusal[] = [];
    const transport = transportOf(() => ({
      kind: 'answer',
      status: 302,
      headers: { location: 'https://evil.example.net/steal' },
      body: new Uint8Array(),
    }));
    const result = await fencedFetch(ABOUT, {
      ...options(transport),
      record: (refusal) => recorded.push(refusal),
    });
    expect(result).toMatchObject({ ok: false, code: 'CAPTURE_HOST_NOT_CATALOGUED' });
    expect(recorded).toHaveLength(1);
    expect(transport.seen).toHaveLength(1);
  });

  it('refuses a redirect loop past three hops', async () => {
    const transport = transportOf((request) => ({
      kind: 'answer',
      status: 301,
      headers: { location: request.url.pathname === '/about' ? SERVICES : ABOUT },
      body: new Uint8Array(),
    }));
    expect(await fencedFetch(ABOUT, options(transport))).toMatchObject({
      ok: false,
      code: 'CAPTURE_TOO_MANY_REDIRECTS',
    });
    expect(transport.seen.length).toBeLessThanOrEqual(4);
  });

  it.each([
    [{ kind: 'timeout' } as const, 'CAPTURE_TIMEOUT'],
    [{ kind: 'oversized' } as const, 'CAPTURE_OVERSIZED'],
    [{ kind: 'failed' } as const, 'CAPTURE_FAILED'],
    [
      {
        kind: 'answer',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: new Uint8Array([123]),
      } as const,
      'CAPTURE_BODY_MALFORMED',
    ],
    [
      {
        kind: 'answer',
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: new Uint8Array([0xff, 0xfe, 0xfd]),
      } as const,
      'CAPTURE_BODY_MALFORMED',
    ],
    [
      {
        kind: 'answer',
        status: 500,
        headers: { 'content-type': 'text/html' },
        body: new Uint8Array(),
      } as const,
      'CAPTURE_STATUS_REFUSED',
    ],
    [
      { kind: 'answer', status: 301, headers: {}, body: new Uint8Array() } as const,
      'CAPTURE_BODY_MALFORMED',
    ],
  ])('refuses and records %o as %s', async (answer, code) => {
    const recorded: FenceRefusal[] = [];
    const result = await fencedFetch(ABOUT, {
      ...options(transportOf(() => answer)),
      record: (refusal) => recorded.push(refusal),
    });
    expect(result).toMatchObject({ ok: false, code });
    expect(recorded.map((entry) => entry.code)).toEqual([code]);
  });
});
