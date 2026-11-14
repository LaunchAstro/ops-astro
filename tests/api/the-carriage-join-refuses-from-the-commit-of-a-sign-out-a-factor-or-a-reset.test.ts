// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines, max-lines-per-function -- one database, each ending raced in each order */
//
// The carriage join (`ops_carry_may_join`) and the door (`standingOf`) on the
// same session while a sign-out, a factor's verification or removal, or a
// reset's window is in flight on a connection of its own. Each step is ordered
// by what the database reports (a transaction holding what it took, a backend
// seen waiting on an advisory key in `pg_stat_activity`), never by a sleep.
// Before the change commits both admit the session as they did; from its
// commit both refuse it (or, for a factor's removal, admit the password-only
// sign-in again), whichever of the join and the change came first. One
// subject's change never refuses another's session, and a login's change in
// one business holds in every business it reaches.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { standingOf } from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  lockLoginFactors,
  recordFactorEnrolled,
  recordFactorRemoved,
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
import {
  endOtherSeenSessions,
  endOwnSession,
  endProviderSession,
  openResetWindow,
  sessionEndedHeld,
  settleResetWindow,
} from '../../packages/core-records/src/identity/sessions.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/verified-subject.ts';
import { connect, type TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { hold as holdRaw } from '../support/lock-wait-race.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import {
  callTopic,
  carriageBusiness,
  carriedCall,
  doorbellTopic,
  mayJoin,
  type CarriageBusiness,
  type Party,
} from './carriage-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** An ending's exclusive advisory wait, as `pg_stat_activity` shows its statement. */
const EXCLUSIVE_KEY = 'pg_advisory_xact_lock(hashtextextended';

interface Session {
  readonly sub: string;
  readonly sessionId: string;
  readonly signedInAt: number;
  readonly secondFactor: boolean;
}

const sessionOf = (party: { readonly sub: string }, secondFactor = false): Session => ({
  sub: party.sub,
  sessionId: randomUUID(),
  signedInAt: nowSeconds() - 300,
  secondFactor,
});

const claimsOf = (s: Session): Record<string, unknown> => ({
  sub: s.sub,
  role: 'authenticated',
  session_id: s.sessionId,
  aal: s.secondFactor ? 'aal2' : 'aal1',
  amr: [
    { method: 'password', timestamp: s.signedInAt },
    ...(s.secondFactor ? [{ method: 'totp', timestamp: s.signedInAt + 5 }] : []),
  ],
});

const presentedOf = (s: Session): VerifiedSubject => ({
  provider: 'supabase',
  subject: s.sub,
  sessionId: s.sessionId,
  assurance: s.secondFactor
    ? { level: 'aal2', signedInAt: s.signedInAt, factorAt: s.signedInAt + 5 }
    : { level: 'aal1', signedInAt: s.signedInAt, factorAt: null },
});

type Ender = (tx: TenantQuery, on: CarriageBusiness, s: Session) => Promise<unknown>;

const ENDERS: readonly [string, Ender][] = [
  ['the provider session ended', async (tx, _on, s) => await endProviderSession(tx, s.sessionId)],
  [
    'signed out of its own session',
    async (tx, on, s) => await endOwnSession(tx, on.owner.person, s.sessionId),
  ],
  [
    "the login's other sessions ended",
    async (tx, on, s) =>
      await endOtherSeenSessions(tx, on.owner.person, randomUUID(), 'end_others', s.sub),
  ],
];

const both = (admitted: boolean) => ({ door: admitted, join: admitted });

/** A verified factor for `party` in `on`, through `tx`, its login's lock taken first. */
async function verifyFactor(tx: TenantQuery, party: Party): Promise<string> {
  await lockLoginFactors(tx, party.sub);
  const factor = await recordFactorEnrolled(tx, {
    personId: party.person,
    subject: party.sub,
    provider: 'supabase',
    providerFactorId: randomUUID(),
  });
  await recordFactorVerified(tx, {
    personId: party.person,
    factorId: factor.id,
    subject: party.sub,
  });
  return factor.id;
}

describe.skipIf(serverUrl === undefined)(
  'the carriage join refuses from the commit of a sign-out, a factor or a reset',
  () => {
    let db: FreshDatabase;

    beforeAll(async () => {
      db = await createFreshDatabase({ part: 'carriage_join_commit' });
    }, 180_000);

    afterAll(async () => await db?.drop());

    /** The join first, then the door, for the owner of `on`'s call (or `topic`). */
    async function ask(
      on: CarriageBusiness,
      s: Session,
      topic = callTopic(on.id, on.callId),
    ): Promise<{ readonly door: boolean; readonly join: boolean }> {
      const join = await mayJoin(db.admin, topic, claimsOf(s));
      const standing = await db.app.withBusiness(on.id, (tx) =>
        standingOf(tx, presentedOf(s), 'required'),
      );
      return { door: 'actorId' in standing, join };
    }

    /** `run` in `on`'s business on a connection of its own, so it may wait while the test asks. */
    async function apart<T>(
      on: CarriageBusiness,
      run: (tx: TenantQuery) => Promise<T>,
    ): Promise<T> {
      const own = connect(db.appUrl);
      try {
        return await own.withBusiness(on.id, run);
      } finally {
        await own.close();
      }
    }

    /** A write's last ask after the session, held: the session's and subject's keys taken shared. */
    const heldAsk = async (on: CarriageBusiness, s: Session) =>
      await hold(db.appUrl, on.id, async (tx) => await sessionEndedHeld(tx, presentedOf(s)));

    /** A join transaction left open after its first answer; `again` asks in it once more. */
    async function openJoin(topic: string, s: Session) {
      let first = false;
      const held = await holdRaw(
        db,
        async (execute) => {
          await execute(`select set_config('request.jwt.claims', $1, true)`, [
            JSON.stringify(claimsOf(s)),
          ]);
          const [row] = await execute<{ readonly ok: boolean }>(
            'select public.ops_carry_may_join($1) as ok',
            [topic],
          );
          first = row?.ok === true;
        },
        async (execute) => {
          const [row] = await execute<{ readonly ok: boolean }>(
            'select public.ops_carry_may_join($1) as ok',
            [topic],
          );
          return row?.ok === true;
        },
      );
      return { first, again: async () => (await held.letGo()) === true };
    }

    describe.each(ENDERS)('%s', (_label, ender) => {
      it('in flight, both admit; from its commit, both refuse', async () => {
        const on = await carriageBusiness(db.app, `flight${randomUUID().slice(0, 8)}`);
        const s = sessionOf(on.owner);
        const ending = await hold(db.appUrl, on.id, async (tx) => await ender(tx, on, s));
        expect(await ask(on, s), 'uncommitted').toEqual(both(true));
        await ending.letGo();
        expect(await ask(on, s), 'committed').toEqual(both(false));
      });

      it('waiting behind a write that holds the session, both admit; once it commits, both refuse', async () => {
        const on = await carriageBusiness(db.app, `behind${randomUUID().slice(0, 8)}`);
        const s = sessionOf(on.owner);
        const writer = await heldAsk(on, s);
        const ending = apart(on, async (tx) => await ender(tx, on, s));
        await waitingOn(db.admin, 'advisory', EXCLUSIVE_KEY);
        expect(await ask(on, s), 'the ending waits').toEqual(both(true));
        await writer.letGo();
        await ending;
        expect(await ask(on, s), 'the ending committed').toEqual(both(false));
      });

      it('a join first, left open: the ending does not wait on it, and its next statement refuses', async () => {
        const on = await carriageBusiness(db.app, `first${randomUUID().slice(0, 8)}`);
        const s = sessionOf(on.owner);
        const join = await openJoin(callTopic(on.id, on.callId), s);
        expect(join.first).toBe(true);
        await db.app.withBusiness(on.id, async (tx) => await ender(tx, on, s));
        expect(await join.again(), 'the open join asked after the commit').toBe(false);
        expect(await ask(on, s)).toEqual(both(false));
      });
    });

    describe('a factor verified or removed', () => {
      it('a verification in flight: password-only admitted by both; from its commit, refused by both', async () => {
        const on = await carriageBusiness(db.app, `factor${randomUUID().slice(0, 8)}`);
        const password = sessionOf(on.owner);
        const verifying = await hold(db.appUrl, on.id, (tx) => verifyFactor(tx, on.owner));
        expect(await ask(on, password), 'uncommitted').toEqual(both(true));
        await verifying.letGo();
        expect(await ask(on, password), 'committed').toEqual(both(false));
        expect(await ask(on, sessionOf(on.owner, true)), 'the factor given').toEqual(both(true));
      });

      it("a verification waiting on the login's factor lock: admitted by both; once it commits, refused", async () => {
        const on = await carriageBusiness(db.app, `factorwait${randomUUID().slice(0, 8)}`);
        const password = sessionOf(on.owner);
        const holder = await hold(db.appUrl, on.id, (tx) => lockLoginFactors(tx, on.owner.sub));
        const verifying = apart(on, (tx) => verifyFactor(tx, on.owner));
        await waitingOn(db.admin, 'advisory', EXCLUSIVE_KEY);
        expect(await ask(on, password), 'the verification waits').toEqual(both(true));
        await holder.letGo();
        await verifying;
        expect(await ask(on, password), 'committed').toEqual(both(false));
      });

      it('a join first, left open: the verification does not wait on it, and its next statement refuses', async () => {
        const on = await carriageBusiness(db.app, `factorfirst${randomUUID().slice(0, 8)}`);
        const password = sessionOf(on.owner);
        const join = await openJoin(callTopic(on.id, on.callId), password);
        expect(join.first).toBe(true);
        await db.app.withBusiness(on.id, (tx) => verifyFactor(tx, on.owner));
        expect(await join.again()).toBe(false);
      });

      it('a removal in flight: password-only refused by both; from its commit, admitted by both again', async () => {
        const on = await carriageBusiness(db.app, `removal${randomUUID().slice(0, 8)}`);
        const password = sessionOf(on.owner);
        const factorId = await db.app.withBusiness(on.id, (tx) => verifyFactor(tx, on.owner));
        expect(await ask(on, password), 'verified').toEqual(both(false));
        const removing = await hold(db.appUrl, on.id, async (tx) => {
          await lockLoginFactors(tx, on.owner.sub);
          await recordFactorRemoved(tx, {
            personId: on.owner.person,
            factorId,
            subject: on.owner.sub,
          });
        });
        expect(await ask(on, password), 'removal uncommitted').toEqual(both(false));
        await removing.letGo();
        expect(await ask(on, password), 'removed').toEqual(both(true));
      });
    });

    describe("a reset's window", () => {
      it('opening in flight: admitted by both; from its commit, refused by both', async () => {
        const on = await carriageBusiness(db.app, `reset${randomUUID().slice(0, 8)}`);
        const before = sessionOf(on.owner);
        const opening = await hold(db.appUrl, on.id, (tx) => openResetWindow(tx, on.owner.sub));
        expect(await ask(on, before), 'uncommitted').toEqual(both(true));
        await opening.letGo();
        expect(await ask(on, before), 'open').toEqual(both(false));
      });

      it("opening behind a write that holds the subject's key: admitted by both; once it commits, refused", async () => {
        const on = await carriageBusiness(db.app, `resetwait${randomUUID().slice(0, 8)}`);
        const before = sessionOf(on.owner);
        const writer = await heldAsk(on, before);
        const opening = apart(on, (tx) => openResetWindow(tx, on.owner.sub));
        await waitingOn(db.admin, 'advisory', EXCLUSIVE_KEY);
        expect(await ask(on, before), 'the open waits').toEqual(both(true));
        await writer.letGo();
        await opening;
        expect(await ask(on, before), 'open').toEqual(both(false));
      });

      it('settling in flight: still refused by both; once settled, a sign-in before it refused and one after it admitted', async () => {
        const on = await carriageBusiness(db.app, `settle${randomUUID().slice(0, 8)}`);
        const before = sessionOf(on.owner);
        const window = await db.app.withBusiness(on.id, (tx) => openResetWindow(tx, on.owner.sub));
        const settling = await hold(db.appUrl, on.id, (tx) => settleResetWindow(tx, window));
        expect(await ask(on, sessionOf(on.owner)), 'settle uncommitted').toEqual(both(false));
        await settling.letGo();
        expect(await ask(on, before), 'settled, signed in before').toEqual(both(false));
        const [row] = await db.admin.execute<{ readonly at: number }>(
          'select ceil(extract(epoch from settled_at))::float8 as at from ops.subject_resets where id = $1',
          [window],
        );
        const after = { ...sessionOf(on.owner), signedInAt: Number(row?.at) + 1 };
        expect(await ask(on, after), 'settled, signed in after').toEqual(both(true));
      });

      it('a join first, left open: the opening of the window does not wait on it, and its next statement refuses', async () => {
        const on = await carriageBusiness(db.app, `resetfirst${randomUUID().slice(0, 8)}`);
        const before = sessionOf(on.owner);
        const join = await openJoin(callTopic(on.id, on.callId), before);
        expect(join.first).toBe(true);
        await db.app.withBusiness(on.id, (tx) => openResetWindow(tx, on.owner.sub));
        expect(await join.again()).toBe(false);
      });
    });

    describe('scope', () => {
      it("one subject's ending, factor and reset refuse no other subject's session", async () => {
        const on = await carriageBusiness(db.app, `scope${randomUUID().slice(0, 8)}`);
        const colleagueCall = await db.app.withBusiness(on.id, (tx) =>
          carriedCall(tx, on.colleague, on.agent),
        );
        const colleague = sessionOf(on.colleague);
        const agent = sessionOf(on.agent);
        const owner = sessionOf(on.owner);
        await db.app.withBusiness(on.id, async (tx) => {
          await endProviderSession(tx, owner.sessionId);
          await endOtherSeenSessions(tx, on.owner.person, undefined, 'end_others', on.owner.sub);
          await verifyFactor(tx, on.owner);
        });
        await db.app.withBusiness(on.id, (tx) => openResetWindow(tx, on.owner.sub));
        expect(await ask(on, owner), 'the owner').toEqual(both(false));
        const colleagueOn = { ...on, callId: colleagueCall.callId };
        expect(await ask(colleagueOn, colleague), 'the colleague').toEqual(both(true));
        expect(await mayJoin(db.admin, doorbellTopic(on.id, on.agent.actor), claimsOf(agent))).toBe(
          true,
        );
        expect(await mayJoin(db.admin, callTopic(on.id, on.callId), claimsOf(agent))).toBe(true);
      });

      it('a login in two businesses: ended, factored or reset through one, refused in the other', async () => {
        for (const [label, change] of [
          [
            'other sessions ended',
            async (tx: TenantQuery, on: CarriageBusiness) =>
              await endOtherSeenSessions(
                tx,
                on.owner.person,
                undefined,
                'end_others',
                on.owner.sub,
              ),
          ],
          [
            'a factor verified',
            async (tx: TenantQuery, on: CarriageBusiness) => await verifyFactor(tx, on.owner),
          ],
          [
            'a reset opened',
            async (tx: TenantQuery, on: CarriageBusiness) =>
              await openResetWindow(tx, on.owner.sub),
          ],
        ] as const) {
          // oxlint-disable-next-line no-await-in-loop -- one pair of businesses at a time
          const here = await carriageBusiness(db.app, `pair${randomUUID().slice(0, 8)}`);
          // oxlint-disable-next-line no-await-in-loop -- one pair of businesses at a time
          const there = await carriageBusiness(db.app, `pair${randomUUID().slice(0, 8)}`, {
            owner: here.owner.sub,
          });
          const s = sessionOf(here.owner);
          // oxlint-disable-next-line no-await-in-loop -- one pair of businesses at a time
          expect(await ask(there, s), `${label}: before`).toEqual(both(true));
          // oxlint-disable-next-line no-await-in-loop -- one pair of businesses at a time
          await db.app.withBusiness(here.id, async (tx) => await change(tx, here));
          // oxlint-disable-next-line no-await-in-loop -- one pair of businesses at a time
          expect(await ask(there, s), `${label}: after, in the other business`).toEqual(
            both(false),
          );
        }
      });
    });
  },
);
