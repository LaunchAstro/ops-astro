// SPDX-License-Identifier: AGPL-3.0-only
//
// `availability.set` runs in a transaction of its own: it takes the audit
// chain key, asks its session again with the session's ending keys held to
// commit, writes its audit event, then upserts the person's one availability
// row. Two read-then-writes, each proved three ways.
//
// The session re-ask: a sign-out sent on another connection once the ask is
// done waits for the write to commit; the ask raising leaves nothing behind;
// and the same set sent again after that crash applies once.
//
// The upsert: two sets by one person on two connections at once leave one row,
// the set the chain records last; the upsert raising takes its audit event
// with it; and the same set sent twice leaves one row as set.
//
// availability.set takes no operation id (its body is state and reason), so a
// retry here is the same body sent again, judged by the row it leaves.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { payloadDigest } from '../../packages/core-digest/src/index.ts';
import { setOwnAvailability } from '../../packages/core-commands/src/index.ts';
import { endProviderSession } from '../../packages/core-records/src/identity/sessions.ts';
import {
  advisoryLock,
  connect,
  type Database,
} from '../../packages/core-records/src/tenancy/database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  failingStatements,
  heldOpen,
  insertsInto,
  locksKey,
  StatementFailed,
} from '../support/failing-statements.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { hold } from '../support/lock-waits.ts';
import { enrol, installSpine, type Member } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

let db: FreshDatabase;
let alpha: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'availability_reask' });
  alpha = await insertBusiness(db.app, 'alpha');
  await installSpine(db.app, alpha);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const onSession = (member: Member): Member => ({
  ...member,
  presented: { ...member.presented, sessionId: randomUUID() },
});

const away = (reason: string): Readonly<Record<string, unknown>> => ({ state: 'away', reason });

const setAs = async (
  database: Database,
  person: Member,
  body: Readonly<Record<string, unknown>>,
): Promise<unknown> => {
  const answer = await setOwnAvailability(database, alpha as never, person.presented, body);
  return 'availability' in answer ? 'applied' : answer.code;
};

/** The person's availability rows and the applied audit events of their sets, in chain order. */
async function keptFor(person: Member): Promise<{
  readonly rows: readonly { readonly state: string; readonly reason: string | null }[];
  readonly applied: readonly string[];
}> {
  const rows = await db.admin.execute<{ readonly state: string; readonly reason: string | null }>(
    `select state, reason from public.person_availability where business_id = $1 and person_id = $2`,
    [alpha, person.personId],
  );
  const events = await db.admin.execute<{ readonly payload_digest: string }>(
    `select payload_digest from public.audit_events
      where business_id = $1 and actor_id = $2 and command = 'availability.set'
        and outcome = 'applied'
      order by seq`,
    [alpha, person.actorId],
  );
  return { rows, applied: events.map((event) => event.payload_digest) };
}

/** Waits until `count` backends wait on an advisory lock. */
async function advisoryWaiters(count: number): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const [row] = await db.admin.execute<{ readonly waiting: number }>(
      `select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and wait_event_type = 'Lock' and wait_event = 'advisory'`,
    );
    if ((row?.waiting ?? 0) >= count) return;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(10);
  }
  throw new Error(`fewer than ${String(count)} backends reached an advisory lock wait`);
}

it.skipIf(serverUrl === undefined)(
  'a sign-out sent once availability has asked its session waits for the set to commit',
  async () => {
    const ada = onSession(await enrol(db.app, alpha, 'Ada Lane'));
    const base = connect(db.appUrl);
    const held = heldOpen(base);
    try {
      const setting = setAs(held.database, ada, away('Lunch'));
      await held.returned;
      const ending = db.app
        .withBusiness(alpha, async (tx) => {
          await endProviderSession(tx, String(ada.presented.sessionId));
        })
        .then(() => 'ended' as const);
      const first = await Promise.race([ending, delay(1_500).then(() => 'waiting' as const)]);
      held.commit();
      const answer = await setting;
      await ending;
      expect({ whileTheSetWasOpen: first, answer, kept: await keptFor(ada) }).toEqual({
        whileTheSetWasOpen: 'waiting',
        answer: 'applied',
        kept: {
          rows: [{ state: 'away', reason: 'Lunch' }],
          applied: [payloadDigest(away('Lunch'))],
        },
      });
    } finally {
      held.commit();
      await base.close();
    }
  },
  60_000,
);

it.skipIf(serverUrl === undefined)(
  'availability whose session re-ask raises writes neither its row nor its audit event',
  async () => {
    const bo = onSession(await enrol(db.app, alpha, 'Bo Hart'));
    const dying = failingStatements(db.app, locksKey('session-ending:session:'), 1);
    await expect(setAs(dying, bo, away('Lunch'))).rejects.toBeInstanceOf(StatementFailed);
    expect(await keptFor(bo)).toEqual({ rows: [], applied: [] });
  },
  60_000,
);

it.skipIf(serverUrl === undefined)(
  'availability sent again after its session re-ask raised applies once',
  async () => {
    const cy = onSession(await enrol(db.app, alpha, 'Cy Ward'));
    const dying = failingStatements(db.app, locksKey('session-ending:session:'), 1);
    await expect(setAs(dying, cy, away('Lunch'))).rejects.toBeInstanceOf(StatementFailed);
    expect(await setAs(db.app, cy, away('Lunch'))).toBe('applied');
    expect(await keptFor(cy)).toEqual({
      rows: [{ state: 'away', reason: 'Lunch' }],
      applied: [payloadDigest(away('Lunch'))],
    });
  },
  60_000,
);

it.skipIf(serverUrl === undefined)(
  'two availability sets by one person at once leave one row, the set the chain records last',
  async () => {
    const dee = await enrol(db.app, alpha, 'Dee Moss');
    const left = connect(db.appUrl);
    const right = connect(db.appUrl);
    try {
      const chain = await hold(db.appUrl, alpha, async (tx) => {
        await advisoryLock(tx, alpha.toLowerCase());
      });
      let both: Promise<unknown[]> | undefined;
      try {
        const lunch = setAs(left, onSession(dee), away('Lunch'));
        await advisoryWaiters(1);
        const meeting = setAs(right, onSession(dee), away('Meeting'));
        await advisoryWaiters(2);
        both = Promise.all([lunch, meeting]);
      } finally {
        await chain.letGo();
      }
      expect(await both).toEqual(['applied', 'applied']);
      const kept = await keptFor(dee);
      const [row] = kept.rows;
      expect({ rows: kept.rows.length, last: kept.applied.at(-1) }).toEqual({
        rows: 1,
        last: payloadDigest(away(String(row?.reason))),
      });
    } finally {
      await Promise.all([left.close(), right.close()]);
    }
  },
  60_000,
);

it.skipIf(serverUrl === undefined)(
  'availability whose row write raises keeps no applied audit event',
  async () => {
    const eli = onSession(await enrol(db.app, alpha, 'Eli Ford'));
    const dying = failingStatements(db.app, insertsInto('person_availability'), 1);
    await expect(setAs(dying, eli, away('Lunch'))).rejects.toBeInstanceOf(StatementFailed);
    expect(await keptFor(eli)).toEqual({ rows: [], applied: [] });
  },
  60_000,
);

it.skipIf(serverUrl === undefined)(
  'the same availability set sent again after a lost response leaves one row as set',
  async () => {
    const fay = onSession(await enrol(db.app, alpha, 'Fay Cole'));
    expect(await setAs(db.app, fay, away('Lunch'))).toBe('applied');
    expect(await setAs(db.app, fay, away('Lunch'))).toBe('applied');
    expect((await keptFor(fay)).rows).toEqual([{ state: 'away', reason: 'Lunch' }]);
  },
  60_000,
);
