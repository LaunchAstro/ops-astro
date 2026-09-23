// SPDX-License-Identifier: AGPL-3.0-only
//
// The client's route derivation and its envelope handling, driven through a
// stubbed `fetch`.
//
// These are the two things a browser test cannot check later: by the time the
// integrated proof runs, a wrong route looks like a 404 from the API and a
// missing `operation_id` looks like a refusal, and neither says which side was
// wrong. Here the request itself is the assertion.

import { describe, expect, it } from 'vitest';
import { OperationsClient, operationPath } from '../../apps/web/src/operations/client.ts';
import { pathOf } from '../../packages/core-records/src/commands/surface.ts';

interface Captured {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function stub(
  answer: unknown,
  status = 200,
): {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(answer), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const make = (fetch: typeof globalThis.fetch, token: string | null = 'tok'): OperationsClient =>
  new OperationsClient({
    base: '/api',
    businessKey: 'alpha',
    token,
    fetch,
    newOperationId: () => 'op-1',
  });

describe('route derivation', () => {
  it('is the business prefix plus the surface path, and never composes its own', async () => {
    const { fetch, calls } = stub({ recordId: 'r1', revision: 1 });
    await make(fetch).mutate('task.create', { fields: { title: 'x' } });
    expect(calls[0]?.url).toBe('/api/b/alpha/task/create');
  });

  it('derives every operation through the surface, including the three reads', () => {
    // The mutations must agree with `pathOf` exactly; the reads follow the same
    // rule, which is what keeps one surface rather than two.
    expect(operationPath('task.assign')).toBe(pathOf('task.assign'));
    expect(operationPath('task.read')).toBe('/task/read');
    expect(operationPath('task.board')).toBe('/task/board');
    expect(operationPath('person.list')).toBe('/person/list');
  });

  it('escapes the business key rather than pasting it into the path', async () => {
    const { fetch, calls } = stub({ ok: true, tasks: [] });
    const client = new OperationsClient({
      base: '/api',
      businessKey: 'a/../b',
      token: 't',
      fetch,
    });
    await client.read('task.board', { board: null });
    expect(calls[0]?.url).toBe('/api/b/a%2F..%2Fb/task/board');
  });
});

describe('the envelope', () => {
  it('spells the envelope in camelCase and sends no second spelling', async () => {
    // The coordinator's 22:53Z ruling: `operationId` and `expectedRevision`,
    // one spelling on the wire. A client sending both would make either
    // server reading pass, which is precisely why it cannot stay.
    const { fetch, calls } = stub({ recordId: 'r1', revision: 2 });
    await make(fetch).mutate(
      'task.update',
      { recordId: 'r1', fields: { title: 'x' } },
      {
        expectedRevision: 1,
      },
    );
    const body = calls[0]?.body ?? {};
    expect(Object.keys(body).toSorted()).toEqual([
      'expectedRevision',
      'fields',
      'operationId',
      'recordId',
    ]);
    expect(body).not.toHaveProperty('operation_id');
    expect(body).not.toHaveProperty('expected_revision');
  });

  it('sends an operation identity on a mutation and none on a read', async () => {
    const { fetch, calls } = stub({ recordId: 'r1', revision: 2 });
    const client = make(fetch);
    await client.mutate('task.start', { recordId: 'r1' }, { expectedRevision: 1 });
    await client.read('task.read', { recordId: 'r1' });
    expect(calls[0]?.body['operationId']).toBe('op-1');
    expect(calls[0]?.body['expectedRevision']).toBe(1);
    expect(calls[1]?.body).not.toHaveProperty('operationId');
    expect(calls[1]?.body).not.toHaveProperty('expectedRevision');
  });

  it('omits the expected revision when the caller has none, so the server can refuse', async () => {
    // A client that invented a revision would make EXPECTED_REVISION_REQUIRED
    // unreachable from the browser.
    const { fetch, calls } = stub({ recordId: 'r1', revision: 1 });
    await make(fetch).mutate('task.update', { recordId: 'r1', fields: { title: 'x' } });
    expect(calls[0]?.body).not.toHaveProperty('expectedRevision');
  });

  it('reuses a caller-supplied identity, so a retry is the same attempt', async () => {
    const { fetch, calls } = stub({ recordId: 'r1', revision: 1 });
    const client = make(fetch);
    await client.mutate(
      'task.complete',
      { recordId: 'r1' },
      { operationId: 'retry-me', expectedRevision: 3 },
    );
    await client.mutate(
      'task.complete',
      { recordId: 'r1' },
      { operationId: 'retry-me', expectedRevision: 3 },
    );
    expect(calls[0]?.body['operationId']).toBe('retry-me');
    expect(calls[1]?.body['operationId']).toBe('retry-me');
  });

  it('carries the token as a bearer and sets no actor or business header', async () => {
    const { fetch, calls } = stub({ ok: true, persons: [] });
    await make(fetch).read('person.list', {});
    const headers = calls[0]?.headers ?? {};
    expect(headers['authorization']).toBe('Bearer tok');
    expect(Object.keys(headers).map((name) => name.toLowerCase())).toEqual([
      'content-type',
      'authorization',
    ]);
  });

  it('puts no business or actor in the body', async () => {
    const { fetch, calls } = stub({ recordId: 'r1', revision: 1 });
    await make(fetch).mutate('task.create', { fields: { title: 'x' }, board: null });
    const body = calls[0]?.body ?? {};
    for (const forbidden of ['businessId', 'businessKey', 'actorId', 'entryPoint']) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });
});

describe('what comes back', () => {
  it("reports a refusal as a refusal, with the server's own code", async () => {
    const { fetch } = stub({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403);
    const result = await make(fetch).read('task.board', { board: null });
    expect(result).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
  });

  it('reports a non-2xx with no refusal body as unavailable, not denied', async () => {
    // Inventing an authority decision nobody made is the failure B7 is about.
    const { fetch } = stub({ oops: true }, 500);
    const result = await make(fetch).read('task.board', { board: null });
    expect(result).toMatchObject({ unavailable: true });
  });

  it('ends the session on either 401 code, and only when a token was sent', async () => {
    // The API tells the two apart on purpose — an unplaceable bearer is
    // `AUTH_UNKNOWN_LOGIN` and a verified one past its `exp` is
    // `AUTH_SESSION_EXPIRED` (`docs/local/API.md`) — and the difference is for
    // the person reading the notice, not for what the client does about it.
    // Recognising only the first is how a person whose hour ran out ends up
    // reading a raw refusal with no way back to sign-in.
    const reported = async (code: string): Promise<readonly string[]> => {
      const ended: string[] = [];
      const { fetch } = stub({ refused: true, code, names: [], fixes: [] }, 401);
      const result = await new OperationsClient({
        base: '/api',
        businessKey: 'alpha',
        token: 'tok',
        fetch,
        newOperationId: () => 'op-1',
        onSessionEnded: (refusal) => ended.push(refusal.code),
      }).read('task.board', { board: null });
      // Reported, never swallowed: the refusal still comes back unchanged.
      expect(result).toMatchObject({ refused: true, code });
      return ended;
    };

    expect(await reported('AUTH_UNKNOWN_LOGIN')).toEqual(['AUTH_UNKNOWN_LOGIN']);
    expect(await reported('AUTH_SESSION_EXPIRED')).toEqual(['AUTH_SESSION_EXPIRED']);

    // A 401 with no bearer is a call nobody was signed in for, and ending a
    // session that was never held would report an event that did not happen.
    const ended: string[] = [];
    const { fetch } = stub(
      { refused: true, code: 'AUTH_SESSION_EXPIRED', names: [], fixes: [] },
      401,
    );
    await new OperationsClient({
      base: '/api',
      businessKey: 'alpha',
      token: null,
      fetch,
      onSessionEnded: (refusal) => ended.push(refusal.code),
    }).read('task.board', { board: null });
    expect(ended).toEqual([]);
  });

  it('reports a transport failure as unavailable', async () => {
    const fetch = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof globalThis.fetch;
    const result = await make(fetch).read('task.read', { recordId: 'r1' });
    expect(result).toMatchObject({ unavailable: true, because: 'connection refused' });
  });
});
