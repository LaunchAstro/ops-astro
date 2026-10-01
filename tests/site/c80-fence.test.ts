// SPDX-License-Identifier: AGPL-3.0-only
//
// C80: the fenced capture (C18-1). Catalogued pages only, its own pool, no
// provider credential, no private network, the hard denies checked on the
// resolved address at every redirect, and every connection pinned to the
// address that was checked.

import { describe, expect, it } from 'vitest';
import {
  checkPageAllowed,
  fencedFetch,
  isDeniedAddress,
  type CapturePool,
  type FenceRefusal,
  type Resolver,
  type Transport,
  type TransportRequest,
} from '../../packages/core-connectors/src/index.ts';

const ABOUT = 'https://www.example.com/about';
const SERVICES = 'https://www.example.com/services';
const PUBLIC_V4 = '93.184.215.14';

const POOL: CapturePool = {
  agencyPages: [ABOUT, SERVICES],
  otherPages: ['https://client.example.org/'],
  closedPoolReviews: [],
};

function resolverOf(...answers: string[][]): Resolver & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const resolve = (host: string) => {
    calls.push(host);
    const answer = answers[Math.min(index, answers.length - 1)] ?? [];
    index += 1;
    return Promise.resolve(answer);
  };
  return Object.assign(resolve, { calls });
}

type Script = (request: TransportRequest) => Awaited<ReturnType<Transport>>;

function transportOf(script: Script): Transport & { seen: TransportRequest[] } {
  const seen: TransportRequest[] = [];
  const transport = (request: TransportRequest) => {
    seen.push(request);
    return Promise.resolve(script(request));
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
});

describe('C80 capture pool allowlist', () => {
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
});

describe('C80 dns rebinding', () => {
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
});
