// SPDX-License-Identifier: AGPL-3.0-only
//
// C59: a person's own second factor through the real API, against a stand-in
// sign-in provider on a loopback port (`c59-factor-routes-world.ts`): every
// hostile answer the provider can give, the lockout after five wrong codes,
// the canary and the three crossings. Enrolment and change are in
// `c59-factor-routes.test.ts`.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { agentPath, bearer, call, serverUrl } from '../acceptance/world.ts';
import {
  act,
  api,
  build,
  CANARY,
  clientA,
  clientB,
  clientC,
  closeRoutes,
  eventsFor,
  factorOf,
  fresh,
  GOOD,
  GOOD_ENROL,
  HOSTILE,
  json,
  openRoutes,
  type Reply,
  type Seen,
  slowApi,
  world,
} from './c59-factor-routes-world.ts';

let replies: Record<string, Reply> = { ...GOOD };
let seen: Seen[] = [];

beforeAll(async () => {
  if (serverUrl === undefined) return;
  await openRoutes('c59h', {
    replies: () => replies,
    saw: (request) => {
      seen.push(request);
    },
  });
}, 60_000);

afterEach(() => {
  replies = { ...GOOD };
  seen = [];
});

afterAll(async () => {
  if (serverUrl === undefined) return;
  await closeRoutes();
});

describe.skipIf(serverUrl === undefined)(
  'C59 a person’s own second factor, through the API',
  () => {
    it.each(HOSTILE)(
      'C59 hostile provider: %s during enrolment is refused, recorded, and changes nothing',
      async (_, reply) => {
        replies['POST /factors'] = reply;
        const answer = await act('enrol', await fresh(world.noah));
        expect(answer.status).toBe(502);
        expect(answer.code).toBe('PROVIDER_ANSWER_INVALID');
        expect(JSON.stringify(answer.body)).not.toContain(CANARY);
        expect(await factorOf(world.noah.personId)).toBeUndefined();
        expect((await eventsFor('account.factor_enrol')).at(-1)).toEqual({
          outcome: 'refused',
          refusal_code: 'PROVIDER_ANSWER_INVALID',
        });
      },
    );

    it('C59 hostile provider: a slow answer is abandoned at the time limit and refused', async () => {
      replies['POST /factors'] = (_q, response) => {
        setTimeout(() => json(200, GOOD_ENROL)(_q, response, ''), 4000).unref();
      };
      const started = Date.now();
      const answer = await act('enrol', await fresh(world.noah), {}, slowApi);
      // Abandoned long before the answer arrives at 4 s; the margin is for a loaded machine.
      expect(Date.now() - started).toBeLessThan(3000);
      expect(answer.code).toBe('PROVIDER_ANSWER_INVALID');
      expect(answer.body['names']).toEqual(['slow']);
      expect(await factorOf(world.noah.personId)).toBeUndefined();
    });

    it('C59 hostile provider: a malformed answer during verification leaves the factor as it was', async () => {
      const token = await fresh(world.noah);
      expect((await act('enrol', token)).status).toBe(200);
      replies['POST /factors/factor-one/verify'] = json(200, { access_token: 7 });
      const answer = await act('verify', token, { code: '123456' });
      expect(answer.code).toBe('PROVIDER_ANSWER_INVALID');
      expect(await factorOf(world.noah.personId)).toMatchObject({ status: 'unverified' });
    });

    it('C59 hostile provider: a provider served under a path is called under that path', async () => {
      replies = { 'POST /auth/v1/factors': GOOD['POST /factors'] ?? json(500, {}) };
      const underPath = await act('enrol', await fresh(clientC), {}, build(undefined, '/auth/v1/'));
      expect(underPath.status).toBe(200);
      expect(seen.map((request) => request.route)).toEqual(['POST /auth/v1/factors']);
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'C59 a person’s own second factor, through the API',
  () => {
    it('C59 factor change: five wrong codes in fifteen minutes stop the provider being asked', async () => {
      const token = await fresh(clientC);
      expect((await act('verify', token, { code: '123456' })).status).toBe(200);
      replies['POST /factors/factor-one/verify'] = json(422, {
        code: 422,
        msg: 'Invalid TOTP code',
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        // oxlint-disable-next-line no-await-in-loop
        expect((await act('verify', token, { code: '000000' })).code).toBe('SECOND_FACTOR_INVALID');
      }
      seen = [];
      const locked = await act('verify', token, { code: '123456' });
      expect(locked.status).toBe(429);
      expect(locked.code).toBe('SECOND_FACTOR_LOCKED');
      const removal = await act('remove', token, { code: '123456' });
      expect(removal.code).toBe('SECOND_FACTOR_LOCKED');
      expect(seen).toEqual([]);
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'C59 a person’s own second factor, through the API',
  () => {
    it('C59 canary: the authenticator secret and the provider’s words reach no log, record or refusal', async () => {
      const written: string[] = [];
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          written.push(args.map(String).join(' '));
        }),
      );
      try {
        const token = await fresh(clientA);
        const enrolled = await act('enrol', token);
        // Shown once, to the person, in the enrol answer: that is the design.
        expect(enrolled.body['secret']).toBe(CANARY);
        replies['POST /factors/factor-one/verify'] = json(500, { msg: CANARY });
        const refused = await act('verify', token, { code: '123456' });
        expect(JSON.stringify(refused.body)).not.toContain(CANARY);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      expect(written.join('\n')).not.toContain(CANARY);
      const stored = await world.db.app.withBusiness(world.alpha, async (tx) => {
        const tables = ['audit_events', 'authentication_attempts', 'second_factors'];
        const dumps = await Promise.all(
          tables.map(async (table) =>
            tx.query<{ readonly row: string }>(`select t::text as row from public.${table} t`),
          ),
        );
        return dumps.flat().map((row) => row.row);
      });
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.join('\n')).not.toContain(CANARY);
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'C59 a person’s own second factor, through the API',
  () => {
    it('C59 isolation: another business, another client and a delegated agent never reach a factor', async () => {
      const before = await factorOf(world.mia.personId);
      // Mia has none left after the change above; give her one again to aim at.
      const token = await fresh(world.mia);
      expect((await act('enrol', token)).status).toBe(200);
      expect((await act('verify', token, { code: '123456' })).status).toBe(200);
      const target = await factorOf(world.mia.personId);
      expect(target).toMatchObject({ status: 'verified' });
      expect(before).toBeUndefined();
      seen = [];

      // Another business: Bea is bravo's, and alpha does not know her.
      const across = await act('remove', await fresh(world.bea), { code: '123456' });
      expect(across.status).toBe(403);
      expect(across.code).toBe('AUTH_NO_MEMBERSHIP');

      // Another client in the same business: client B acts only on client B's
      // own account, and a body naming anyone else's factor is refused.
      const other = await act('remove', await fresh(clientB), { code: '123456' });
      expect(other.code).toBe('FACTOR_NOT_ENROLLED');
      const named = await act('remove', await fresh(clientB), {
        code: '123456',
        factorId: target?.id,
      });
      expect(named.code).toBe('COMMAND_BODY_INVALID');

      // Another person under a live delegation: the agent acting for Ada finds
      // no factor route on its prefix at all.
      const agent = await call(
        api,
        agentPath('alpha', '/account/factor/remove'),
        { code: '123456' },
        bearer(world.agent.token),
      );
      expect(agent.status).toBe(404);

      expect(seen).toEqual([]);
      expect(await factorOf(world.mia.personId)).toEqual(target);
    });
  },
);
