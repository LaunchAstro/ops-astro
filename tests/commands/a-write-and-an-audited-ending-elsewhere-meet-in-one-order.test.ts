// SPDX-License-Identifier: AGPL-3.0-only
//
// A write through the envelope and an audited ending of its session through
// another business (#1291, Sol's round-1 coverage on #2414). The ending takes
// that business's audit chain, then the login's subject key (ending every
// other session of the login) or the session's key (a sign-out of this one).
// The write holds its own business's chain and takes both keys shared at its
// last ask (`sessionEndedHeld`), so:
// - an ending holding its key first is waited for, and the write is refused
//   with nothing kept: no preference, no operation, no applied audit event;
// - an ending sent after the write's last ask waits for the write to commit.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
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

/** A member of alpha signed in on a session of their own, and the same login's person in beta. */
async function signedInTwice() {
  const member = await enrol(db.app, alpha, `Ivy ${randomUUID().slice(0, 6)}`);
  const me: Member = { ...member, presented: { ...member.presented, sessionId: randomUUID() } };
  const { business: beta, person: there } = await standingElsewhere(db, me.presented.subject);
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

/** What the save left in alpha: the preference, its register rows and its applied audit events. */
async function kept(me: Member, operationId: string): Promise<unknown> {
  const [row] = await db.admin.execute(
    `select (select value from public.person_preferences
              where business_id = $1 and person_id = $2 and key = 'appearance') as value,
            (select count(*)::int from public.operations
              where business_id = $1 and operation_id = $3 and outcome = 'applied') as operations,
            (select count(*)::int from public.audit_events
              where business_id = $1 and operation_id = $3 and outcome = 'applied') as applied`,
    [alpha, me.personId, operationId],
  );
  return row;
}

it.skipIf(serverUrl === undefined).each(ENDINGS)(
  'a save whose session is being ended through another business by %s waits for it, then keeps nothing',
  async (_name, ending) => {
    const { me, beta, there } = await signedInTwice();
    const operationId = randomUUID();
    const saver = connect(db.appUrl);
    let held: Held | undefined;
    try {
      let holder = 0;
      held = await hold(db.appUrl, beta, async (tx) => {
        holder = await backendPid(tx);
        await ending(tx, there, me);
      });
      let settled = false;
      const saving = save(saver, me, operationId).finally(() => {
        settled = true;
      });
      await blockedBy(db.admin, holder, () => settled, 'the save');
      await held.letGo();
      held = undefined;
      const answer = await saving;
      expect({
        answer: isCommandRefusal(answer) ? answer.code : 'applied',
        kept: await kept(me, operationId),
      }).toStrictEqual({
        answer: 'AUTH_SESSION_EXPIRED',
        kept: { value: null, operations: 0, applied: 0 },
      });
    } finally {
      await held?.letGo();
      await saver.close();
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
    // The save's own transaction, kept open after the command has done all
    // its work, its last ask included, and before it commits.
    const heldOpen: Database = {
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
      const saving = save(heldOpen, me, operationId);
      await returned.promise;
      const ended = db.app
        .withBusiness(beta, async (tx) => await ending(tx, there, me))
        .then(() => 'ended' as const);
      const first = await Promise.race([ended, delay(1_500).then(() => 'waiting' as const)]);
      commit.release();
      const answer = await saving;
      await ended;
      expect({
        whileTheSaveWasOpen: first,
        answer: isCommandRefusal(answer) ? answer.code : 'applied',
        kept: await kept(me, operationId),
      }).toStrictEqual({
        whileTheSaveWasOpen: 'waiting',
        answer: 'applied',
        kept: { value: 'dark', operations: 1, applied: 0 },
      });
    } finally {
      commit.release();
      await base.close();
    }
  },
);
