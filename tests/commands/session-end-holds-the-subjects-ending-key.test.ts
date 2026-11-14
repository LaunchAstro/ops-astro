// SPDX-License-Identifier: AGPL-3.0-only
//
// `session.end` (#2427) asks whether its session has ended and then ends it,
// under the ending's keys. A reset's window (C40) ends every session of the
// login and takes the subject's key alone; a factor change through another
// business ends them too and takes that business's chain and the subject's
// key. Sharing only the subject's key with both, `session.end` takes it too,
// in the one order (chain, subject, session), so either ending commits before
// its ask and it is refused, or the ending waits for it to commit (Sol's
// coverage on #2465). Real connections, one per side.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  endOtherSeenSessions,
  openResetWindow,
} from '../../packages/core-records/src/identity/sessions.ts';
import {
  connect,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
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
let bravo: string;
let bravoPerson: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'session_end_subject_key' });
  alpha = await insertBusiness(db.app, 'alpha');
  bravo = await insertBusiness(db.app, 'bravo');
  await installSpine(db.app, alpha);
  await installSpine(db.app, bravo);
  bravoPerson = (await enrol(db.app, bravo, 'Bea Bravo')).personId;
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

/** A member signed in on a session of their own. */
async function signedIn(name: string): Promise<Member> {
  const member = await enrol(db.app, alpha, name);
  return { ...member, presented: { ...member.presented, sessionId: randomUUID() } };
}

const endCommand = (database: Database, who: Member) =>
  executeCommand(database, alpha, who.presented, 'api', {
    command: 'session.end',
    operationId: randomUUID(),
  } as never);

/** The two subject-wide endings: a reset's window, and a factor change's ending through bravo. */
const ENDINGS: readonly {
  readonly name: string;
  readonly business: () => string;
  readonly end: (tx: TenantQuery, subject: string) => Promise<unknown>;
}[] = [
  {
    name: 'a reset’s window',
    business: () => alpha,
    end: async (tx, subject) => await openResetWindow(tx, subject),
  },
  {
    name: 'a factor change’s ending through another business',
    business: () => bravo,
    end: async (tx, subject) =>
      await endOtherSeenSessions(tx, bravoPerson, undefined, 'end_others', subject),
  },
];

/** An ending behind a session.end about to commit waits for it. */
function endingWaitsFor(ending: (typeof ENDINGS)[number]): void {
  it.skipIf(serverUrl === undefined)(
    `${ending.name} waits for a session.end that is about to commit`,
    async () => {
      const gus = await signedIn(`Gus ${randomUUID().slice(0, 4)}`);
      const base = connect(db.appUrl);
      const returned = gate();
      const commit = gate();
      // session.end's own transaction, kept open after its work, before it commits.
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
      const other = connect(db.appUrl);
      try {
        const closing = endCommand(held, gus);
        await returned.promise;
        const competing = other
          .withBusiness(ending.business() as never, async (tx) => {
            await ending.end(tx, gus.presented.subject);
          })
          .then(() => 'ended' as const);
        const first = await Promise.race([competing, delay(1_500).then(() => 'waiting' as const)]);
        commit.release();
        const answer = await closing;
        await competing;
        expect({
          whileSessionEndWasOpen: first,
          answer: isCommandRefusal(answer) ? answer.code : 'applied',
        }).toStrictEqual({ whileSessionEndWasOpen: 'waiting', answer: 'applied' });
      } finally {
        commit.release();
        await base.close();
        await other.close();
      }
    },
  );
}

/** session.end behind an ending still open: it waits, then is refused and ends nothing. */
function sessionEndWaitsFor(ending: (typeof ENDINGS)[number]): void {
  it.skipIf(serverUrl === undefined)(
    `session.end waits for ${ending.name} still to commit, then is refused and ends nothing`,
    async () => {
      const ned = await signedIn(`Ned ${randomUUID().slice(0, 4)}`);
      const competing = await hold(db.appUrl, ending.business(), async (tx) => {
        await ending.end(tx, ned.presented.subject);
      });
      const ender = connect(db.appUrl);
      try {
        const asked = endCommand(ender, ned).then((answer) => answer);
        const first = await Promise.race([
          asked.then(() => 'answered' as const),
          waitingOn(db.admin, 'advisory', '').then(
            () => 'waiting' as const,
            () => 'never waited' as const,
          ),
        ]);
        await competing.letGo();
        const answer = await asked;
        const [own] = await db.admin.execute<{ readonly n: number }>(
          `select count(*)::int as n from public.ended_sessions
            where business_id = $1 and session_id = $2::uuid and reason = 'sign_out'`,
          [alpha, ned.presented.sessionId],
        );
        expect({
          whileTheEndingWasOpen: first,
          answer: isCommandRefusal(answer) ? answer.code : 'applied',
          endedBySessionEnd: own?.n,
        }).toStrictEqual({
          whileTheEndingWasOpen: 'waiting',
          answer: 'AUTH_SESSION_EXPIRED',
          endedBySessionEnd: 0,
        });
      } finally {
        await ender.close();
      }
    },
  );
}

for (const ending of ENDINGS) {
  endingWaitsFor(ending);
  sessionEndWaitsFor(ending);
}
