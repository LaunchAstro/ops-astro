// SPDX-License-Identifier: AGPL-3.0-only
//
// The browser's refusal parser, against the boundary's own bytes.
//
// `tests/surfaces/operations-client.test.ts` hands the client a refusal body it
// wrote itself, so it establishes that the parser reads *that* shape and
// nothing about whether the API emits it. That is the gap the previous review
// recorded against the closed HTTP-refusal defect: the fix was assessed by
// inspection, and the committed client test still supplied its own body.
//
// Here the real Hono app is asked for a refusal and its response is handed
// straight to the real `OperationsClient`, unopened. Nothing in between writes
// a body. If `refused: true` ever left `apps/api/app.ts`, or a code, name or
// fix stopped crossing, the client would read the answer as *unavailable* —
// "nothing has been decided about your access" — and every refusal the product
// makes would be drawn to a person as an outage.

import { describe, expect, it } from 'vitest';
import { sign } from 'hono/jwt';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import {
  OperationsClient,
  isRefusal,
  isUnavailable,
} from '../../apps/web/src/operations/client.ts';
import { describeRefusal } from '../../apps/web/src/records/submit.ts';

const SECRET = 'a-local-test-secret-that-is-not-the-running-one';
const ALPHA = '11111111-1111-4111-8111-111111111111';
const MIA = '22222222-2222-4222-8222-222222222222';

/**
 * Every case below is refused before the database is asked for anything but
 * the one row the boundary writes itself: a non-object body's admission
 * refusal (root ruling 4). That insert is answered with nothing; any other
 * statement throws.
 */
const stubDatabase = (): Database =>
  ({
    log: { record: () => undefined, statements: () => [] },
    withBusiness: async (businessId: string, run: (tx: unknown) => Promise<unknown>) =>
      await run({
        businessId,
        query: async (text: string) => {
          if (!text.trimStart().startsWith('insert into public.authentication_attempts')) {
            throw new Error('the stub database has no rows');
          }
          return [];
        },
      }),
    close: async () => undefined,
  }) as unknown as Database;

const api = createApi({
  database: stubDatabase(),
  verify: createSupabaseVerifier({ secret: SECRET }),
  resolveBusiness: async (key) => (key === 'alpha' ? ALPHA : undefined),
  executeCommand,
  executeRead,
});

/**
 * The client's transport, wired to the app itself.
 *
 * This is the whole point of the file: the `Response` the client parses is the
 * one `createApi` built, with its own status, its own headers and its own
 * bytes. No case here may construct a body.
 */
const transport = (async (url: string | URL, init?: RequestInit) =>
  api.fetch(new Request(String(url), init))) as unknown as typeof globalThis.fetch;

const client = (token: string | null): OperationsClient =>
  new OperationsClient({
    origin: 'http://api.test',
    businessKey: 'alpha',
    token,
    fetch: transport,
    newOperationId: () => '33333333-3333-4333-8333-333333333333',
  });

const tokenFor = async (subject: string): Promise<string> =>
  await sign(
    {
      sub: subject,
      aud: 'authenticated',
      role: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 600,
    },
    SECRET,
    'HS256',
  );

describe('a refusal crossing the boundary into the browser client', () => {
  it('is read as a refusal, not as the API being unavailable', async () => {
    const result = await client(null).mutate('task.create', { fields: { title: 'anything' } });

    expect(isUnavailable(result)).toBe(false);
    expect(isRefusal(result)).toBe(true);
    if (!isRefusal(result)) return;

    // The three fields a person is shown, all of them the server's own. The
    // code is asserted by name because it is what code branches on.
    expect(result.refused).toBe(true);
    expect(result.code).toBe('AUTH_UNKNOWN_LOGIN');
    expect(Array.isArray(result.names)).toBe(true);
    expect(result.fixes.length).toBeGreaterThan(0);

    // And what the screen puts in front of a person quotes the server verbatim
    // rather than a friendlier word chosen in the browser.
    const shown = describeRefusal(result);
    expect(shown).toContain('AUTH_UNKNOWN_LOGIN');
    for (const fix of result.fixes) expect(shown).toContain(fix);
  });

  it('carries the names and fixes of a business the caller cannot reach', async () => {
    const stranger = new OperationsClient({
      origin: 'http://api.test',
      businessKey: 'bravo',
      token: await tokenFor(MIA),
      fetch: transport,
      newOperationId: () => '44444444-4444-4444-8444-444444444444',
    });

    const result = await stranger.read('task.board', { board: null });
    expect(isRefusal(result)).toBe(true);
    if (!isRefusal(result)) return;

    expect(result.refused).toBe(true);
    expect(typeof result.code).toBe('string');
    expect(result.fixes.length).toBeGreaterThan(0);
    // An unresolvable business and a business with no membership must not be
    // told apart by the bytes, so the code is the assertion and the wording is
    // the server's; this case only requires that both reach the client.
    expect(describeRefusal(result)).toContain(result.code);
  });

  it('is a refusal even when the request body is not an object at all', async () => {
    const response = await api.fetch(
      new Request(`http://api.test/api/b/alpha/task/create`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor(MIA)}`,
        },
        body: '"not an object"',
      }),
    );
    const body = (await response.json()) as Record<string, unknown>;

    // Read as the client reads it: the flag, then the code.
    expect(body['refused']).toBe(true);
    expect(typeof body['code']).toBe('string');
    expect(Array.isArray(body['names'])).toBe(true);
    expect(Array.isArray(body['fixes'])).toBe(true);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
