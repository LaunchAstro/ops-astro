// SPDX-License-Identifier: AGPL-3.0-only
//
// A write asks its session once more after its last wait, and holds that
// session's ending keys until it commits, so a sign-out either committed
// before the ask and refuses the write, or waits for the write to commit.
// Two entry points: the envelope (a preference save, which writes no audit
// event) and availability, which has its own transaction. The ending here is
// a provider session ended in every business (`endProviderSession`), which a
// sign-out through another business takes and which waits on no audit chain.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { setOwnAvailability } from '../../packages/core-commands/src/index.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { endProviderSession } from '../../packages/core-records/src/identity/sessions.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { gate, hold, waitingOn } from '../support/lock-waits.ts';
import { enrol, installSpine, type Member } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

let db: FreshDatabase;
let alpha: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'ending_keys_held' });
  alpha = await insertBusiness(db.app, 'alpha');
  await installSpine(db.app, alpha);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

/** A member signed in on a session of their own. */
async function signedIn(name: string): Promise<Member> {
  const member = await enrol(db.app, alpha, name);
  return { ...member, presented: { ...member.presented, sessionId: randomUUID() } };
}

const endSession = async (sessionId: string): Promise<void> => {
  await db.app.withBusiness(alpha, async (tx) => {
    await endProviderSession(tx, sessionId);
  });
};

async function appearanceOf(person: Member): Promise<unknown> {
  const [row] = await db.admin.execute<{ readonly value: unknown }>(
    `select value from public.person_preferences
      where business_id = $1 and person_id = $2 and key = 'appearance'`,
    [alpha, person.personId],
  );
  return row?.value;
}

it.skipIf(serverUrl === undefined)(
  'a sign-out of the session that sent a preference save waits for the save to commit',
  async () => {
    const gus = await signedIn('Gus Reed');
    const sessionId = String(gus.presented.sessionId);
    const base = connect(db.appUrl);
    const returned = gate();
    const commit = gate();
    // The save's own transaction, kept open after the command has done all
    // its work and before it commits.
    const held: Database = {
      log: base.log,
      close: async () => await base.close(),
      withBusiness: async (id, run) =>
        await base.withBusiness(id, async (tx) => {
          const answer = await run(tx);
          returned.release();
          await commit.promise;
          return answer;
        }),
    };
    try {
      const saving = executeCommand(held, alpha, gus.presented, 'api', {
        command: 'preference.save',
        operationId: randomUUID(),
        preference: 'appearance',
        value: 'dark',
      } as never);
      await returned.promise;
      const ending = endSession(sessionId).then(() => 'ended' as const);
      const first = await Promise.race([ending, delay(1_500).then(() => 'waiting' as const)]);
      commit.release();
      const answer = await saving;
      await ending;
      expect({
        whileTheSaveWasOpen: first,
        answer: isCommandRefusal(answer) ? answer.code : 'applied',
        value: await appearanceOf(gus),
      }).toStrictEqual({ whileTheSaveWasOpen: 'waiting', answer: 'applied', value: 'dark' });
    } finally {
      commit.release();
      await base.close();
    }
  },
);

it.skipIf(serverUrl === undefined)(
  'availability set while its session ended during the audit wait is refused and writes nothing',
  async () => {
    const ada = await signedIn('Ada Lane');
    const setter = connect(db.appUrl);
    try {
      const chain = await hold(db.appUrl, alpha, async (tx) => {
        await tx.query('select pg_advisory_xact_lock(hashtextextended($1::text, 0))', [alpha]);
      });
      let setting: ReturnType<typeof setOwnAvailability> | undefined;
      try {
        setting = setOwnAvailability(setter, alpha as never, ada.presented, {
          state: 'away',
          reason: 'Lunch',
        });
        // Parked on the chain key, wherever it is taken: the audit insert's
        // trigger, or a lock the write takes itself before it.
        await waitingOn(db.admin, 'advisory', '');
        await endSession(String(ada.presented.sessionId));
      } finally {
        await chain.letGo();
      }
      const answer = await setting;
      const [kept] = await db.admin.execute(
        `select (select count(*)::int from public.person_availability
                  where business_id = $1 and person_id = $2) as rows,
                (select count(*)::int from public.audit_events
                  where business_id = $1 and actor_id = $3 and outcome = 'applied'
                    and command = 'availability.set') as applied`,
        [alpha, ada.personId, ada.actorId],
      );
      expect({
        answer: 'availability' in answer ? 'applied' : answer.code,
        kept,
      }).toStrictEqual({ answer: 'AUTH_SESSION_EXPIRED', kept: { rows: 0, applied: 0 } });
    } finally {
      await setter.close();
    }
  },
);
