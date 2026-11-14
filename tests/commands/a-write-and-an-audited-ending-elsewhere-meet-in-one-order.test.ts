// SPDX-License-Identifier: AGPL-3.0-only
//
// A write through the envelope and an audited ending of its session through
// another business (#1291, Sol's coverage on #2414). The login is signed in on
// one provider session, seen in both businesses. An ending through beta takes
// beta's audit chain, then the login's subject key (an ending of every other
// session of the login), then each seen session's key; a sign-out takes the
// chain and the session's key. The write holds alpha's chain and takes the
// subject's and the session's keys shared at its last ask (`sessionEndedHeld`):
// - an ending holding its keys first is waited for, and the write is refused
//   keeping nothing: no preference, no register row, no applied audit event;
// - an ending holding the subject's key but not yet the session's makes the
//   write wait at the subject, then takes the session's key and refuses it;
// - an ending sent after the write's last ask waits for the write to commit.
// Each wait is observed in `pg_blocking_pids` before anything is released.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { holdSubjectEnding } from '../../packages/core-records/src/identity/ending-keys.ts';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  endOtherSeenSessions,
  endOwnSession,
} from '../../packages/core-records/src/identity/sessions.ts';
import {
  connect,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { backendPid, blockedBy } from '../identity/factor-ending-keys-fixture.ts';
import { standingElsewhere } from '../identity/factor-lock-wait-fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { gate, hold, type Held } from '../support/lock-waits.ts';
import { enrol, installSpine, type Member } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

let db: FreshDatabase;
let alpha: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'audited_ending_elsewhere' });
  alpha = await insertBusiness(db.app, 'alpha');
  await installSpine(db.app, alpha);
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

/** A member of alpha signed in on one session, the same login's person in beta, the session seen there too. */
async function signedInTwice() {
  const member = await enrol(db.app, alpha, `Ivy ${randomUUID().slice(0, 6)}`);
  const me: Member = { ...member, presented: { ...member.presented, sessionId: randomUUID() } };
  const { business: beta, person: there } = await standingElsewhere(db, me.presented.subject);
  const seen = await db.app.withBusiness(beta, (tx) => resolveLogin(tx, me.presented, 'enrolling'));
  expect('refused' in seen).toBe(false);
  return { me, beta, there };
}

type Ending = (tx: TenantQuery, there: string, me: Member) => Promise<unknown>;

/** The two audited endings through beta that reach the alpha session. */
const ENDINGS: readonly (readonly [string, Ending])[] = [
  [
    'a sign-out of the session',
    (tx, there, me) => endOwnSession(tx, there, me.presented.sessionId),
  ],
  [
    'an ending of every other session of the login',
    (tx, there, me) =>
      endOtherSeenSessions(tx, there, randomUUID(), 'end_others', me.presented.subject),
  ],
];

const save = (database: Database, me: Member, operationId: string) =>
  executeCommand(database, alpha, me.presented, 'api', {
    command: 'preference.save',
    operationId,
    preference: 'appearance',
    value: 'dark',
  } as never);

/** What the save left in alpha: the preference, every register row of its id, its applied audit events. */
async function kept(me: Member, operationId: string): Promise<unknown> {
  const [row] = await db.admin.execute(
    `select (select value from public.person_preferences
              where business_id = $1 and person_id = $2 and key = 'appearance') as value,
            (select count(*)::int from public.operations
              where business_id = $1 and operation_id = $3) as operations,
            (select count(*)::int from public.audit_events
              where business_id = $1 and operation_id = $3 and outcome = 'applied') as applied`,
    [alpha, me.personId, operationId],
  );
  return row;
}

const refusedKeepingNothing = {
  answer: 'AUTH_SESSION_EXPIRED',
  kept: { value: null, operations: 0, applied: 0 },
};

/** The save on its own connection, and whether it has settled. */
function saving(me: Member, operationId: string) {
  const saver = connect(db.appUrl);
  let settled = false;
  const answer = save(saver, me, operationId).finally(() => {
    settled = true;
  });
  return { answer, settled: () => settled, close: async () => await saver.close() };
}

it.skipIf(serverUrl === undefined).each(ENDINGS)(
  'a save whose session is being ended through another business by %s waits for it, then keeps nothing',
  async (_name, ending) => {
    const { me, beta, there } = await signedInTwice();
    const operationId = randomUUID();
    let held: Held | undefined;
    let saver: ReturnType<typeof saving> | undefined;
    try {
      let holder = 0;
      held = await hold(db.appUrl, beta, async (tx) => {
        holder = await backendPid(tx);
        await ending(tx, there, me);
      });
      saver = saving(me, operationId);
      await blockedBy(db.admin, holder, saver.settled, 'the save');
      await held.letGo();
      held = undefined;
      const answer = await saver.answer;
      expect({
        answer: isCommandRefusal(answer) ? answer.code : 'applied',
        kept: await kept(me, operationId),
      }).toStrictEqual(refusedKeepingNothing);
    } finally {
      await held?.letGo();
      await saver?.close();
    }
  },
);

it.skipIf(serverUrl === undefined)(
  'an ending through another business holding the subject key, not yet the session key, makes the save wait, then refuses it',
  async () => {
    const { me, beta, there } = await signedInTwice();
    const operationId = randomUUID();
    const ender = connect(db.appUrl);
    const subjectHeld = gate();
    const goOn = gate();
    let holder = 0;
    let saver: ReturnType<typeof saving> | undefined;
    // The ending's keys in its own order, paused between the subject's and the session's.
    const ended = ender.withBusiness(beta, async (tx) => {
      holder = await backendPid(tx);
      await holdSubjectEnding(tx, me.presented.subject);
      subjectHeld.release();
      await goOn.promise;
      return await endOtherSeenSessions(
        tx,
        there,
        randomUUID(),
        'end_others',
        me.presented.subject,
      );
    });
    try {
      await subjectHeld.promise;
      saver = saving(me, operationId);
      await blockedBy(db.admin, holder, saver.settled, 'the save at the subject key');
      goOn.release();
      expect(await ended).toBe(1);
      const answer = await saver.answer;
      expect({
        answer: isCommandRefusal(answer) ? answer.code : 'applied',
        kept: await kept(me, operationId),
      }).toStrictEqual(refusedKeepingNothing);
    } finally {
      goOn.release();
      await Promise.allSettled([ended]);
      await saver?.close();
      await ender.close();
    }
  },
);

it.skipIf(serverUrl === undefined).each(ENDINGS)(
  'through another business, %s sent after a save asked its session last waits for the save to commit',
  async (_name, ending) => {
    const { me, beta, there } = await signedInTwice();
    const operationId = randomUUID();
    const base = connect(db.appUrl);
    const returned = gate();
    const commit = gate();
    let writer = 0;
    // The save's own transaction, kept open after the command has done all
    // its work, its last ask included, and before it commits.
    const heldOpen: Database = {
      log: base.log,
      close: async () => await base.close(),
      withBusiness: async (id, run) =>
        await base.withBusiness(id, async (tx) => {
          const answer = await run(tx);
          writer = await backendPid(tx);
          returned.release();
          await commit.promise;
          return answer;
        }),
    };
    try {
      const answering = save(heldOpen, me, operationId);
      await returned.promise;
      let endingSettled = false;
      const ended = db.app
        .withBusiness(beta, async (tx) => await ending(tx, there, me))
        .finally(() => {
          endingSettled = true;
        });
      await blockedBy(db.admin, writer, () => endingSettled, 'the ending');
      commit.release();
      const answer = await answering;
      await ended;
      expect({
        answer: isCommandRefusal(answer) ? answer.code : 'applied',
        kept: await kept(me, operationId),
      }).toStrictEqual({ answer: 'applied', kept: { value: 'dark', operations: 1, applied: 0 } });
    } finally {
      commit.release();
      await base.close();
    }
  },
);
