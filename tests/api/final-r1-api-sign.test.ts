// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 1, lane FR1-API-SIGN, the boundary half.
//
// R1-AUTHORITY-2: `hono/jwt` checks `exp` before it checks the signature, so a
// forged bearer with a past `exp` used to reach the verifier's catch as
// `JwtTokenExpired` and was answered `AUTH_SESSION_EXPIRED`. That code means
// the bearer's signature verifies and its `exp` has passed (API.md); anything
// else is `AUTH_UNKNOWN_LOGIN`, on both prefixes.
//
// R1-AUTHORITY-24: the business key is not unique in the schema, so a key two
// businesses hold names no business. The resolver refuses it rather than
// taking whichever row the heap returned first and caching it.
//
// No database: the verifier answers before the key is resolved, and the
// resolver is driven through a substitute owner connection.

import { describe, expect, it } from 'vitest';
import { sign } from 'hono/jwt';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { createBusinessResolver } from '../../apps/api/server.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { executeAgentCommand } from '../../packages/core-records/src/commands/agent-envelope.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';

const SECRET = 'a-local-test-secret-for-final-r1-api-sign';
const ALPHA = '11111111-1111-4111-8111-111111111111';
const BRAVO = '33333333-3333-4333-8333-333333333333';
const MIA = '22222222-2222-4222-8222-222222222222';

/** Never reached: every case here is answered at admission step 1. */
const unreachable: Database = {
  log: { record: () => undefined, statements: () => [] } as unknown as Database['log'],
  withBusiness: async () => {
    throw new Error('admission step 1 answers before any business is entered');
  },
  close: async () => undefined,
};

function build() {
  return createApi({
    database: unreachable,
    verify: createSupabaseVerifier({ secret: SECRET }),
    resolveBusiness: async (key) => (key === 'alpha' ? ALPHA : undefined),
    executeCommand,
    executeRead,
    executeAgentCommand,
  });
}

const PREFIXES = [
  ['person', '/api/b/alpha/task/create'],
  ['agent', '/api/a/b/alpha/task/queue'],
] as const;

async function codeFor(path: string, token: string) {
  const response = await build().fetch(
    new Request(`http://api.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ operationId: 'final-r1-api-sign' }),
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, code: body['code'] };
}

const past = () => Math.floor(Date.now() / 1000) - 60;
const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('R1-AUTHORITY-2: only a verified signature can be reported as expired', () => {
  for (const [prefix, path] of PREFIXES) {
    it(`${prefix} prefix: a past-exp bearer signed with another secret is AUTH_UNKNOWN_LOGIN`, async () => {
      const forged = await sign({ sub: MIA, exp: past() }, 'another-secret', 'HS256');
      expect(await codeFor(path, forged)).toStrictEqual({
        status: 401,
        code: 'AUTH_UNKNOWN_LOGIN',
      });
    });

    it(`${prefix} prefix: a past-exp bearer with its signature replaced is AUTH_UNKNOWN_LOGIN`, async () => {
      const genuine = await sign({ sub: MIA, exp: past() }, SECRET, 'HS256');
      const garbled = `${genuine.slice(0, genuine.lastIndexOf('.'))}.AAAA`;
      expect(await codeFor(path, garbled)).toStrictEqual({
        status: 401,
        code: 'AUTH_UNKNOWN_LOGIN',
      });
    });

    it(`${prefix} prefix: the reviewer's unsigned schedule (exp 1, signature AAAA) is AUTH_UNKNOWN_LOGIN`, async () => {
      const token = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: 'x', exp: 1 })}.AAAA`;
      expect(await codeFor(path, token)).toStrictEqual({
        status: 401,
        code: 'AUTH_UNKNOWN_LOGIN',
      });
    });

    it(`${prefix} prefix: a past-exp bearer this deployment signed stays AUTH_SESSION_EXPIRED`, async () => {
      const expired = await sign({ sub: MIA, exp: past() }, SECRET, 'HS256');
      expect(await codeFor(path, expired)).toStrictEqual({
        status: 401,
        code: 'AUTH_SESSION_EXPIRED',
      });
    });
  }
});

/** An owner connection that answers the key lookup with fixed rows and counts the lookups. */
function admin(rows: readonly { id: string }[]): AdminConnection & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    log: { record: () => undefined, statements: () => [] } as unknown as AdminConnection['log'],
    execute: async <Row>(text: string) => {
      asked.push(text);
      return rows as unknown as readonly Row[];
    },
    transaction: async () => {
      throw new Error('the resolver opens no transaction');
    },
    close: async () => undefined,
  } as AdminConnection & { readonly asked: string[] };
}

describe('R1-AUTHORITY-24: a key two businesses hold resolves to neither', () => {
  it('answers undefined, the unresolved refusal, when the key matches two businesses', async () => {
    const resolve = createBusinessResolver(admin([{ id: ALPHA }, { id: BRAVO }]));
    expect(await resolve('acme')).toBeUndefined();
  });

  it('does not cache the ambiguous answer: the key is asked again next time', async () => {
    const connection = admin([{ id: ALPHA }, { id: BRAVO }]);
    const resolve = createBusinessResolver(connection);
    await resolve('acme');
    await resolve('acme');
    expect(connection.asked).toHaveLength(2);
  });

  it('still resolves and caches a key exactly one business holds', async () => {
    const connection = admin([{ id: ALPHA }]);
    const resolve = createBusinessResolver(connection);
    expect(await resolve('acme')).toBe(ALPHA);
    expect(await resolve('acme')).toBe(ALPHA);
    expect(connection.asked).toHaveLength(1);
  });
});
