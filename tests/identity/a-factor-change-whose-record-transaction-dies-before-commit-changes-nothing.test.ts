// SPDX-License-Identifier: AGPL-3.0-only
//
// A factor act's record step runs its check and writes its event, then asks
// the session and the caller's standing again (`judged`). A fixture holds the
// caller's session ending key, so the record step parks on that last ask, its
// check and event written and not committed. Its statement is then cancelled
// from the admin connection, which aborts the transaction. (Terminating the
// backend instead throws inside the postgres driver, outside this act.) The
// act must fail with nothing kept: no factor enrolled, verified or removed, no
// applied event of the act, nothing removed at the provider.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import type { FactorProvider } from '../../packages/core-commands/src/commands/account-factor-provider.ts';
import { sessionKey } from '../../packages/core-records/src/identity/ending-keys.ts';
import {
  liveFactor,
  recordFactorEnrolled,
} from '../../packages/core-records/src/identity/second-factor.ts';
import {
  advisoryLock,
  connect,
  type BusinessId,
} from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { gate, hold, waitingOn } from '../support/lock-waits.ts';
import { insertBusiness } from './fixture.ts';
import { ACTS, factorCaller, provider } from './factor-lock-wait-fixture.ts';

const it = databaseUrlFromEnvironment() === undefined ? vitestIt.skip : vitestIt;

let db: FreshDatabase;
let business: BusinessId;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  db = await createFreshDatabase({ part: 'factorcrash' });
  business = (await insertBusiness(db.app, 'factor-crash')) as BusinessId;
}, 180_000);
afterAll(async () => {
  await db?.drop();
});

type ActName = 'enrol' | 'verify' | 'remove';

/** A caller ready for `act`: a verified factor to remove, or an enrolment to verify. */
async function readyFor(act: ActName) {
  const { caller, person } = await factorCaller(db, business, act === 'remove');
  if (act === 'verify')
    await db.app.withBusiness(business, (tx) =>
      recordFactorEnrolled(tx, {
        personId: person,
        subject: caller.presented.subject,
        provider: 'supabase',
        providerFactorId: `factor-${randomUUID()}`,
      }),
    );
  return { caller, person };
}

/** The provider, its first call held until `go`, so the act's first transaction has committed. */
function gated(act: ActName, removed: string[]) {
  const reached = gate();
  const go = gate();
  const answering = provider(removed);
  const call = act === 'enrol' ? 'enrol' : 'verify';
  const to: FactorProvider = {
    ...answering,
    [call]: async (...args: never[]) => {
      reached.release();
      await go.promise;
      return await (answering[call] as (...a: never[]) => Promise<unknown>)(...args);
    },
  };
  return { to, reached, go };
}

/** The person's live factor, and how many applied events of `act` they have. */
async function left(act: ActName, person: string, subject: string) {
  const [events] = await db.admin.execute<{ readonly applied: number }>(
    `select count(*)::int as applied from public.audit_events e
       join public.actors a on a.business_id = e.business_id and a.id = e.actor_id
      where e.business_id = $1 and a.person_id = $2::uuid and e.command = $3
        and e.outcome = 'applied'`,
    [business, person, `account.factor_${act}`],
  );
  const live = await db.app.withBusiness(business, (tx) => liveFactor(tx, person, subject));
  return { status: live?.status ?? 'none', applied: events?.applied };
}

it.each(['enrol', 'verify', 'remove'] as const)(
  'a factor %s whose record transaction dies after its check and before commit changes nothing',
  async (act) => {
    const { caller: asked, person } = await readyFor(act);
    const before = await left(act, person, asked.presented.subject);
    const removed: string[] = [];
    const { to, reached, go } = gated(act, removed);
    const actor = connect(db.appUrl);
    try {
      const acting = ACTS[act]({ ...asked, database: actor }, to).then(
        () => 'answered',
        () => 'failed',
      );
      await reached.promise;
      const sessionId = asked.presented.sessionId ?? '';
      const ending = await hold(db.appUrl, business, async (tx) => {
        await advisoryLock(tx, sessionKey(sessionId));
      });
      try {
        go.release();
        await waitingOn(db.admin, 'advisory', 'pg_advisory_xact_lock_shared');
        const killed = await db.admin.execute<{ readonly killed: boolean }>(
          `select pg_cancel_backend(pid) as killed from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
              and wait_event = 'advisory' and strpos(query, 'pg_advisory_xact_lock_shared') > 0`,
        );
        expect(killed).toEqual([{ killed: true }]);
      } finally {
        go.release();
        await ending.letGo();
      }
      expect({
        outcome: await acting,
        left: await left(act, person, asked.presented.subject),
        removed,
      }).toEqual({
        outcome: 'failed',
        left: { ...before, applied: 0 },
        removed: [],
      });
    } finally {
      go.release();
      await actor.close();
    }
  },
);
