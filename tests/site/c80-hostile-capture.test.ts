// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 hostile provider, the capture path: the fenced capture (C18-1) meeting
// a hostile answer. Catalogued pages only, its own pool, no
// provider credential, no private network, the hard denies checked on the
// resolved address at every redirect, and every connection pinned to the
// address that was checked.

import { describe, expect, it } from 'vitest';
import {
  fencedFetch,
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

const options = (transport: Transport) => ({
  pool: POOL,
  resolve: resolverOf([PUBLIC_V4], [OTHER_PUBLIC_V4]),
  transport,
  kind: 'document' as const,
});

describe('C80 hostile provider (capture path)', () => {
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
});

describe('C80 hostile provider (capture path)', () => {
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
