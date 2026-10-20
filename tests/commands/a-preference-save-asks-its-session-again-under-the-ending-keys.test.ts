// SPDX-License-Identifier: AGPL-3.0-only
//
// The envelope asks a write's session once more after the write's last wait,
// with the business's audit chain key and then the session's ending keys held
// to commit. A preference save writes no audit event, so the ask is the first
// thing to take the chain key. Three proofs at that step: a sign-out that
// commits on another connection while the save waits for the chain key; the
// ask itself raising, so the transaction dies there; and the same operation
// sent again after that crash and after a lost response.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { endProviderSession } from '../../packages/core-records/src/identity/sessions.ts';
import {
  advisoryLock,
  connect,
  type Database,
} from '../../packages/core-records/src/tenancy/database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { failingStatements, locksKey, StatementFailed } from '../support/failing-statements.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { enrol, installSpine, type Member } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

let db: FreshDatabase;
let alpha: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'save_reask' });
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

const save = async (
  database: Database,
  person: Member,
  operationId: string,
  value: string,
): Promise<unknown> =>
  await executeCommand(database, alpha as never, person.presented, 'api', {
    command: 'preference.save',
    operationId,
    preference: 'appearance',
    value,
  } as never);

const answerOf = (answer: unknown): unknown =>
  isCommandRefusal(answer as object) ? (answer as { readonly code: unknown }).code : 'applied';

/** What the save kept: the stored value, its register rows and its audit outcomes. */
async function keptBy(person: Member, operationId: string): Promise<unknown> {
  const [kept] = await db.admin.execute(
    `select (select value from public.person_preferences
              where business_id = $1 and person_id = $2 and key = 'appearance') as value,
            (select count(*)::int from public.operations
              where operation_id = $3 and actor_id = $4) as registered,
            (select coalesce(array_agg(outcome order by seq), '{}') from public.audit_events
              where business_id = $1 and operation_id = $3) as audited`,
    [alpha, person.personId, operationId, person.actorId],
  );
  return kept;
}

it.skipIf(serverUrl === undefined)(
  'a preference save whose session signed out while it waited on the chain key is refused and saves nothing',
  async () => {
    const gus = await signedIn('Gus Reed');
    const operationId = randomUUID();
    const chain = await hold(db.appUrl, alpha, async (tx) => {
      await advisoryLock(tx, alpha.toLowerCase());
    });
    // The save on a connection of its own: the sign-out needs the pool's.
    const saver = connect(db.appUrl);
    let saving: Promise<unknown> | undefined;
    try {
      saving = save(saver, gus, operationId, 'dark');
      await waitingOn(db.admin, 'advisory', 'pg_advisory_xact_lock');
      await db.app.withBusiness(alpha, async (tx) => {
        await endProviderSession(tx, String(gus.presented.sessionId));
      });
    } finally {
      await chain.letGo();
    }
    try {
      expect({
        answer: answerOf(await saving),
        kept: await keptBy(gus, operationId),
      }).toMatchObject({ answer: 'AUTH_SESSION_EXPIRED', kept: { value: null, registered: 0 } });
    } finally {
      await saver.close();
    }
  },
  60_000,
);

it.skipIf(serverUrl === undefined)(
  'a preference save whose session re-ask raises keeps nothing and records its failed attempt',
  async () => {
    const ivy = await signedIn('Ivy Shaw');
    const operationId = randomUUID();
    const dying = failingStatements(db.app, locksKey('session-ending:session:'), 1);
    await expect(save(dying, ivy, operationId, 'dark')).rejects.toBeInstanceOf(StatementFailed);
    expect(await keptBy(ivy, operationId)).toStrictEqual({
      value: null,
      registered: 0,
      audited: ['failed'],
    });
  },
  60_000,
);

it.skipIf(serverUrl === undefined)(
  'a preference save sent again after its re-ask raised applies once and its replay moves nothing',
  async () => {
    const joe = await signedIn('Joe Park');
    const operationId = randomUUID();
    const dying = failingStatements(db.app, locksKey('session-ending:session:'), 1);
    await expect(save(dying, joe, operationId, 'dark')).rejects.toBeInstanceOf(StatementFailed);
    const first = await save(db.app, joe, operationId, 'dark');
    // A later intent of the same person moves the value on.
    expect(answerOf(await save(db.app, joe, randomUUID(), 'light'))).toBe('applied');
    // The first operation sent again after a lost response.
    const again = await save(db.app, joe, operationId, 'dark');
    expect({ first: answerOf(first), again, kept: await keptBy(joe, operationId) }).toStrictEqual({
      first: 'applied',
      again: first,
      kept: { value: 'light', registered: 1, audited: ['failed'] },
    });
  },
  60_000,
);
