// SPDX-License-Identifier: AGPL-3.0-only
//
// The routes beside the generated surface (the session exchange, the live
// streams and presence, the account's factor and session routes, and the
// person's own availability) tell the security detector what a surface route
// tells it. A rejected credential on each is one `sign-in-failed` signal, as
// on `task.queue`; a verified caller at a business key that names no business
// is one `cross-scope-refusal`; a request that tried no credential at all
// counts nothing. It goes red if any of these routes answers without the
// detector's step. No database: the door refuses before any statement runs.

import { describe, expect, it, vi } from 'vitest';
import { createApi, type ApiOptions } from '../../apps/api/app.ts';
import type { SecuritySignal } from '../../apps/api/alerts/detect.ts';
import type { Verifier } from '../../apps/api/auth/supabase.ts';
import type { LiveTopics } from '../../apps/api/live.ts';
import type { FactorProvider } from '../../packages/core-commands/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { CSRF_HEADER } from '../../packages/core-wire/src/index.ts';

const ORIGIN = 'http://api.test';
const TASK = '44444444-4444-4444-8444-444444444444';

/** Each route beside the surface, and the surface route it is compared with. */
const ROUTES = [
  ['GET', '/api/b/alpha/live'],
  ['GET', `/api/b/alpha/live?topic=task:${TASK}`],
  ['GET', `/api/b/alpha/live/task/${TASK}`],
  ['GET', `/api/b/alpha/live/presence?task=${TASK}`],
  ['POST', '/api/b/alpha/live/mark'],
  ['POST', '/api/b/alpha/account/factor/enrol'],
  ['POST', '/api/b/alpha/account/sessions/list'],
  ['POST', '/api/b/alpha/account/availability'],
  ['POST', '/api/b/alpha/task/queue'],
] as const;

function build(verify: Verifier) {
  const signals: SecuritySignal[] = [];
  const unused = vi.fn(() => {
    throw new Error('the door let a refused caller through');
  });
  const options: ApiOptions = {
    database: {} as Database,
    verify,
    resolveBusiness: async (key) =>
      await Promise.resolve(key === 'known' ? 'business-1' : undefined),
    executeRead: unused as never,
    executeCommand: unused as never,
    factors: {} as FactorProvider,
    live: {
      topics: { listening: true } as unknown as LiveTopics,
      admit: unused as never,
      presence: { mark: unused, seenBy: unused } as never,
    },
    observe: (signal) => signals.push(signal),
  };
  return { api: createApi(options), signals };
}

const send = async (
  api: ReturnType<typeof createApi>,
  method: string,
  path: string,
  headers: Record<string, string> = {},
) =>
  await api.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(method === 'POST' ? { body: '{}' } : {}),
    }),
  );

/** Rejects every bearer it is shown; with none, nothing was presented. */
const rejecting: Verifier = async (request) =>
  await Promise.resolve(request.header('authorization') === undefined ? 'absent' : undefined);

describe('the routes beside the surface and the security detector', () => {
  it.each(ROUTES)('%s %s: a rejected credential is one failed sign-in', async (method, path) => {
    const { api, signals } = build(rejecting);
    const response = await send(api, method, path, { authorization: 'Bearer not-a-token' });
    expect(response.status).toBe(401);
    expect(signals).toEqual([{ kind: 'sign-in-failed', business: 'alpha', person: '' }]);
  });

  it('the session exchange: a rejected credential is one failed sign-in', async () => {
    const { api, signals } = build(rejecting);
    const response = await send(api, 'POST', '/api/session', {
      authorization: 'Bearer not-a-token',
      [CSRF_HEADER]: '1',
      'sec-fetch-site': 'same-origin',
    });
    expect(response.status).toBe(401);
    expect(signals).toEqual([{ kind: 'sign-in-failed', business: '', person: '' }]);
  });

  it.each(ROUTES)('%s %s: a request with no credential counts nothing', async (method, path) => {
    const { api, signals } = build(rejecting);
    expect((await send(api, method, path)).status).toBe(401);
    expect(signals).toEqual([]);
  });

  it.each(ROUTES.map(([method, path]) => [method, path.replace('/b/alpha/', '/b/nowhere/')]))(
    '%s %s: a verified caller at a key naming no business is one cross-scope refusal',
    async (method, path) => {
      const subject = { provider: 'test', subject: 'person-1' };
      const { api, signals } = build(async () => await Promise.resolve(subject));
      const response = await send(api, method, path, { authorization: 'Bearer verified' });
      expect(response.status).toBe(403);
      expect(signals).toEqual([
        { kind: 'cross-scope-refusal', business: 'nowhere', person: 'test\u0000person-1' },
      ]);
    },
  );
});
