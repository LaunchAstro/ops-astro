// SPDX-License-Identifier: AGPL-3.0-only
//
// C59: a person's own second factor through the real API, against a stand-in
// sign-in provider on a loopback port (`c59-factor-routes-world.ts`): first
// enrolment, two tabs enrolling at once, and a factor changed. The hostile
// provider, the lockout, the canary and the isolation cases are in
// `c59-factor-routes-hostile.test.ts`.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { serverUrl } from '../acceptance/world.ts';
import {
  act,
  build,
  CANARY,
  clientD,
  closeRoutes,
  eventsFor,
  factorOf,
  fresh,
  GOOD,
  GOOD_TOTP,
  json,
  now,
  openRoutes,
  type Reply,
  type Seen,
  tokenFor,
  world,
} from './c59-factor-routes-world.ts';

let replies: Record<string, Reply> = { ...GOOD };
let seen: Seen[] = [];

beforeAll(async () => {
  if (serverUrl === undefined) return;
  await openRoutes('c59r', {
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
    it('C59 first enrolment: a stale password sign-in is refused and the provider is never asked', async () => {
      const stale = await tokenFor(world.mia.subject, { aal: 'aal1', password: now() - 3601 });
      const answer = await act('enrol', stale);
      expect(answer.status).toBe(403);
      expect(answer.code).toBe('FRESH_SIGN_IN_REQUIRED');
      expect(seen).toEqual([]);
      expect(await factorOf(world.mia.personId)).toBeUndefined();
      expect((await eventsFor('account.factor_enrol')).at(-1)).toEqual({
        outcome: 'refused',
        refusal_code: 'FRESH_SIGN_IN_REQUIRED',
      });
    });

    it('C59 first enrolment: a fresh password sign-in with no factor enrols, and the first code completes it', async () => {
      const token = await fresh(world.mia);
      const enrolled = await act('enrol', token);
      expect(enrolled.status).toBe(200);
      expect(enrolled.body).toMatchObject({ factorId: 'factor-one', secret: CANARY });
      expect(seen.map((request) => request.route)).toEqual(['POST /factors']);
      expect(seen[0]?.authorization).toBe(`Bearer ${token}`);
      expect(await factorOf(world.mia.personId)).toMatchObject({ status: 'unverified' });

      // One event for the act, written with its record after the provider
      // answered; the check before the call recorded nothing, having done nothing.
      const enrolEvents = await eventsFor('account.factor_enrol');
      expect(enrolEvents.filter((event) => event.outcome === 'applied')).toHaveLength(1);

      const verified = await act('verify', token, { code: '123456' });
      expect(verified.status).toBe(200);
      expect(verified.body).toMatchObject({ accessToken: 'aal2-access-token' });
      expect(await factorOf(world.mia.personId)).toMatchObject({ status: 'verified' });
      expect((await eventsFor('account.factor_verify')).at(-1)).toEqual({
        outcome: 'applied',
        refusal_code: null,
      });
    });

    it('C59 first enrolment: a person who already has a verified factor is refused a second one', async () => {
      const answer = await act('enrol', await fresh(world.mia));
      expect(answer.status).toBe(409);
      expect(answer.code).toBe('FACTOR_ALREADY_ENROLLED');
      expect(seen).toEqual([]);
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'C59 a person’s own second factor, through the API',
  () => {
    it('C59 two enrolments at once: both tabs are answered, and one live factor remains', async () => {
      // Both requests pass the check before the provider call, and the provider
      // answers neither until it holds both, so both record steps run together.
      const held: Array<() => void> = [];
      let issued = 0;
      replies['POST /factors'] = (_request, response) => {
        issued += 1;
        const id = `factor-race-${issued}`;
        held.push(() => json(200, { id, type: 'totp', totp: GOOD_TOTP })(_request, response, ''));
        if (held.length === 2) for (const release of held) release();
      };
      // Two connections, as a server with a wider pool has: on one connection
      // the transactions queue and the race cannot happen.
      const wide = connect(world.db.appUrl, { source: 'runtime', max: 2 });
      const token = await fresh(clientD);
      const via = build(undefined, '', wide);
      const [first, second] = await Promise.all([
        act('enrol', token, {}, via),
        act('enrol', token, {}, via),
      ]).finally(async () => await wide.close());

      expect([first.status, second.status]).toEqual([200, 200]);
      const rows = await world.db.app.withBusiness(world.alpha, async (tx) =>
        tx.query<{ readonly provider_factor_id: string; readonly status: string }>(
          `select provider_factor_id, status from public.second_factors
            where person_id = $1 order by enrolled_at, provider_factor_id`,
          [clientD.personId],
        ),
      );
      // The later record replaces the earlier: one live, the other ended.
      expect(rows.map((row) => row.status).toSorted()).toEqual(['removed', 'unverified']);
      expect(new Set(rows.map((row) => row.provider_factor_id))).toEqual(
        new Set(['factor-race-1', 'factor-race-2']),
      );
      expect(await factorOf(clientD.personId)).toMatchObject({ status: 'unverified' });
      const applied = (await eventsFor('account.factor_enrol')).filter(
        (event) => event.outcome === 'applied',
      );
      expect(applied.length).toBeGreaterThanOrEqual(2);
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'C59 a person’s own second factor, through the API',
  () => {
    it('C59 factor change: removing needs the current code, entered for that change', async () => {
      const token = await fresh(world.mia);

      const bare = await act('remove', token, {});
      expect(bare.code).toBe('COMMAND_BODY_INVALID');
      expect(seen).toEqual([]);

      replies['POST /factors/factor-one/verify'] = json(422, {
        code: 422,
        msg: 'Invalid TOTP code',
      });
      const wrong = await act('remove', token, { code: '000000' });
      expect(wrong.status).toBe(422);
      expect(wrong.code).toBe('SECOND_FACTOR_INVALID');
      expect(seen.map((request) => request.route)).not.toContain('DELETE /factors/factor-one');
      expect(await factorOf(world.mia.personId)).toMatchObject({ status: 'verified' });
      expect((await eventsFor('account.factor_remove')).at(-1)).toEqual({
        outcome: 'refused',
        refusal_code: 'SECOND_FACTOR_INVALID',
      });

      replies = { ...GOOD };
      seen = [];
      const removed = await act('remove', token, { code: '123456' });
      expect(removed.status).toBe(200);
      // The removal is made with the aal2 session the code just gave, not the
      // password-only bearer the request arrived with.
      const deletion = seen.find((request) => request.route === 'DELETE /factors/factor-one');
      expect(deletion?.authorization).toBe('Bearer aal2-access-token');
      expect(await factorOf(world.mia.personId)).toBeUndefined();
      // The person row's mirror follows the factor rows: no verified factor
      // left, so a sign-in without one is enough again.
      const mirrored = await world.db.app.withBusiness(world.alpha, async (tx) =>
        tx.query<{ readonly on: boolean }>(
          'select second_factor_verified as on from public.people where id = $1',
          [world.mia.personId],
        ),
      );
      expect(mirrored[0]?.on).toBe(false);
    });
  },
);
