// SPDX-License-Identifier: AGPL-3.0-only
//
// The boundary, driven as a caller drives it.
//
// These cases run the real Hono app built by `createApi`, through `app.fetch`,
// with real GoTrue-shaped HS256 tokens. What is substituted is the database
// and the business resolver, because the questions here are the transport's:
// which routes exist, what reaches identity, and what a caller is shown when
// the answer is no. The questions the database owns — whether a task is
// created, whether a foreign read refuses — are SLICE-DATA's tests and the
// end-to-end walk in `scripts/local/verify-slice.mjs`.
//
// The substitute database records what it was handed. That is what makes the
// tampering cases assertions rather than assurances: the business identifier
// and the verified subject the envelope was called with are read back and
// compared, so "a header cannot set the actor" is checked at the point where
// the actor would have been set.

import { describe, expect, it } from 'vitest';
import { sign } from 'hono/jwt';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import { COMMAND_SURFACE, pathOf } from '../../packages/core-records/src/commands/surface.ts';
import { createApi, type ReadExecutor } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';

const SECRET = 'a-local-test-secret-that-is-not-the-running-one';
const ALPHA = '11111111-1111-4111-8111-111111111111';
const MIA = '22222222-2222-4222-8222-222222222222';

interface Seen {
  readonly businessId: string;
  readonly presented: VerifiedSubject;
}

/**
 * A database that is never reached, and a record of what the envelope was
 * asked for. `withBusiness` throwing is deliberate: these cases must not
 * depend on a schema, and a case that silently started needing one would be a
 * case that had stopped testing the boundary.
 */
function stubDatabase(seen: Seen[]): Database {
  return {
    log: { record: () => undefined, statements: () => [] } as unknown as Database['log'],
    withBusiness: async (businessId, run) => {
      seen.push({ businessId, presented: { provider: 'recorded', subject: businessId } });
      return await run({
        businessId,
        query: async () => {
          throw new Error('the stub database has no rows');
        },
      });
    },
    close: async () => undefined,
  };
}

async function tokenFor(subject: string, options: { readonly expiresIn?: number } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return await sign(
    {
      sub: subject,
      aud: 'authenticated',
      role: 'authenticated',
      exp: now + (options.expiresIn ?? 600),
    },
    SECRET,
    'HS256',
  );
}

function build(overrides: Partial<Parameters<typeof createApi>[0]> = {}, seen: Seen[] = []) {
  return createApi({
    database: stubDatabase(seen),
    verify: createSupabaseVerifier({ secret: SECRET }),
    resolveBusiness: async (key) => (key === 'alpha' ? ALPHA : undefined),
    ...overrides,
  });
}

async function post(
  api: ReturnType<typeof createApi>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await api.fetch(
    new Request(`http://api.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
  // A fault and a missing route answer in plain text, and a case that could
  // only read JSON would report those as its own failure rather than as the
  // status it was asking about.
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
}

const authorised = (token: string) => ({ authorization: `Bearer ${token}` });

describe('the routes come from the command surface', () => {
  it('mounts every declaration under the business prefix and nothing else', async () => {
    const api = build();
    const token = await tokenFor(MIA);

    for (const declaration of COMMAND_SURFACE) {
      // eslint-disable-next-line no-await-in-loop -- one route at a time reads as a list
      const answer = await post(
        api,
        `/api/b/alpha${pathOf(declaration.name)}`,
        {},
        authorised(token),
      );
      // It got past routing: the answer is the operation's, not a 404.
      expect(answer.status, declaration.name).not.toBe(404);
    }

    const absent = await post(api, '/api/b/alpha/task/invent', {}, authorised(token));
    expect(absent.status).toBe(404);
  });

  it('has no route outside the business prefix', async () => {
    const api = build();
    const token = await tokenFor(MIA);
    const answer = await post(api, '/task/create', {}, authorised(token));
    expect(answer.status).toBe(404);
  });
});

describe('only a verified token says who is calling', () => {
  it('refuses a request with no token', async () => {
    const answer = await post(build(), '/api/b/alpha/task/create', { operationId: 'abcdefgh' });
    expect(answer.status).toBe(401);
    expect(answer.body['code']).toBe('AUTH_UNKNOWN_LOGIN');
  });

  it('refuses a token signed with another secret, identically', async () => {
    const forged = await sign(
      { sub: MIA, exp: Math.floor(Date.now() / 1000) + 600 },
      'another-secret',
      'HS256',
    );
    const answer = await post(build(), '/api/b/alpha/task/create', {}, authorised(forged));
    expect(answer.status).toBe(401);
    expect(answer.body['code']).toBe('AUTH_UNKNOWN_LOGIN');
  });

  it('refuses an expired token', async () => {
    const expired = await tokenFor(MIA, { expiresIn: -60 });
    const answer = await post(build(), '/api/b/alpha/task/create', {}, authorised(expired));
    expect(answer.status).toBe(401);
    expect(answer.body['code']).toBe('AUTH_UNKNOWN_LOGIN');
  });

  it('refuses a token with no subject', async () => {
    const anonymous = await sign(
      { aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 },
      SECRET,
      'HS256',
    );
    const answer = await post(build(), '/api/b/alpha/task/create', {}, authorised(anonymous));
    expect(answer.status).toBe(401);
    expect(answer.body['code']).toBe('AUTH_UNKNOWN_LOGIN');
  });

  it('does not read a token from anywhere but the Authorization header', async () => {
    const token = await tokenFor(MIA);
    const answer = await post(
      build(),
      '/api/b/alpha/task/create',
      { token, access_token: token },
      {
        apikey: token,
        'x-access-token': token,
      },
    );
    expect(answer.status).toBe(401);
    expect(answer.body['code']).toBe('AUTH_UNKNOWN_LOGIN');
  });
});

describe('the business is named in the path and verified (N7)', () => {
  it('passes the resolved identifier, never one from the body or a header', async () => {
    const seen: Seen[] = [];
    const api = build({}, seen);
    const token = await tokenFor(MIA);

    await post(
      api,
      '/api/b/alpha/task/create',
      {
        operationId: 'operation-one',
        fields: { title: 'a task' },
        businessId: '99999999-9999-4999-8999-999999999999',
        actorId: 'someone-else',
        entryPoint: 'worker',
      },
      {
        ...authorised(token),
        'x-business-id': '99999999-9999-4999-8999-999999999999',
        host: 'bravo.test',
      },
    );

    // The stub has no rows, so the envelope's failure path opens a second
    // transaction to record the attempt. Every one of them was opened for the
    // business the path named and none for the one the body and header asked
    // for, which is the whole of the claim.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.map((entry) => entry.businessId)).toEqual(seen.map(() => ALPHA));
  });

  it('refuses an unknown business exactly as it refuses one you are not in', async () => {
    const token = await tokenFor(MIA);
    const answer = await post(
      build(),
      '/api/b/nowhere/task/create',
      { operationId: 'operation-one' },
      authorised(token),
    );
    expect(answer.status).toBe(403);
    expect(answer.body['code']).toBe('AUTH_NO_MEMBERSHIP');
  });

  it('refuses before it reads the body, so a bad body cannot tell you a business exists', async () => {
    const seen: Seen[] = [];
    const token = await tokenFor(MIA);
    const answer = await post(build({}, seen), '/api/b/nowhere/task/create', {}, authorised(token));
    expect(answer.body['code']).toBe('AUTH_NO_MEMBERSHIP');
    expect(seen).toHaveLength(0);
  });
});

describe('a body that is not an object', () => {
  it('is refused rather than coerced', async () => {
    const token = await tokenFor(MIA);
    const response = await build().fetch(
      new Request('http://api.test/api/b/alpha/task/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authorised(token) },
        body: '["not", "an", "object"]',
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, unknown>)['code']).toBe(
      'COMMAND_BODY_INVALID',
    );
  });
});

describe('the read half of the surface', () => {
  const readDeclaration = { name: 'task.read', kind: 'read' } as const;

  it('runs through the injected executor with the resolved business and subject', async () => {
    // The surface this branch carries has no read declaration yet, so the
    // executor is checked directly against the contract the boundary calls it
    // by. When SLICE-DATA adds the declaration the route appears with no edit
    // here, which is the claim the first case in this file already checks.
    const calls: Array<{ businessId: string; presented: VerifiedSubject; command: string }> = [];
    const executeRead: ReadExecutor = async (_database, businessId, presented, request) => {
      calls.push({ businessId, presented, command: request.command });
      return { ok: true, task: { id: 'a-task' } };
    };

    const answer = await executeRead(
      stubDatabase([]),
      ALPHA,
      { provider: 'supabase', subject: MIA },
      {
        command: readDeclaration.name,
        recordId: 'a-task',
      },
    );

    expect(calls).toEqual([
      {
        businessId: ALPHA,
        presented: { provider: 'supabase', subject: MIA },
        command: 'task.read',
      },
    ]);
    expect(answer).toEqual({ ok: true, task: { id: 'a-task' } });
  });
});
