// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared world of the MP-4-8 "Duplicate without contents" cases: two
// businesses, two clients in the first, and the helpers the cases read. A
// harness, not a suite: nothing here runs on its own.
//
// A client's name and aliases are read from the business's `client` record
// (`tasks-duplicate.ts`); this base installs no client model, so the world
// plants that record type and its records as the owner would.

import { randomUUID } from 'node:crypto';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { ReadResult } from '../../packages/core-commands/src/reads/requests.ts';
import type { CommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { BusinessId, EntryPoint } from '../../packages/core-records/src/index.ts';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();
export const CANARY: string = `canary-${randomUUID()}`;
export const ENTRIES: readonly EntryPoint[] = ['app', 'api', 'cli'];

export let db: FreshDatabase;
export let alpha: BusinessId;
export let bravo: BusinessId;
/** Business-wide read, write and share on tasks, and write on time and tags. */
export let owner: Member;
export let bravoWriter: Member;
/** Client A's and client B's party ids, and client A's name and alias. */
export let clientA: string;
export let clientB: string;
export const CLIENT_A_NAME = 'Harbourline Dental';
export const CLIENT_A_ALIAS = 'HLD Group';

export const outcomeOf = (answer: CommandResult): Readonly<Record<string, unknown>> =>
  isCommandRefusal(answer) ? { code: answer.code, names: answer.names } : { applied: true };

export const as = async (
  business: BusinessId,
  member: Member,
  body: Record<string, unknown>,
  entry: EntryPoint = 'api',
): Promise<CommandResult> =>
  await executeCommand(db.app, business, member.presented, entry, {
    operationId: randomUUID(),
    ...body,
  } as never);

export const revisionOf = async (recordId: string): Promise<number> =>
  Number(
    (
      await db.admin.execute<{ readonly revision: string }>(
        `select revision::text as revision from public.records where id = $1`,
        [recordId],
      )
    )[0]?.revision,
  );

/** A new task in `business`, and its client set through `task.set_party`. */
export const taskFor = async (
  business: BusinessId,
  by: Member,
  title: string,
  client: string | null,
): Promise<string> => {
  const made = await as(business, by, { command: 'task.create', fields: { title } });
  if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
  const recordId = made.recordId ?? '';
  if (client !== null) {
    const party = await as(business, by, {
      command: 'task.set_party',
      recordId,
      expectedRevision: await revisionOf(recordId),
      fields: { client },
    });
    if (isCommandRefusal(party)) throw new Error(`set_party refused ${party.code}`);
  }
  return recordId;
};

/** A duplicate as the panel sends it: the chosen client and the edited shell. */
export const duplicate = async (
  by: Member,
  body: {
    readonly recordId: string;
    readonly client: string | null;
    readonly title: string;
    readonly stepNames?: readonly string[];
    readonly confirmCarried?: boolean;
  },
  entry: EntryPoint = 'api',
  business: BusinessId = alpha,
): Promise<CommandResult> =>
  await as(
    business,
    by,
    {
      command: 'task.duplicate',
      stepNames: [],
      confirmCarried: false,
      ...body,
    },
    entry,
  );

/** What a refused duplicate must leave: the counts of tasks, links and applied events. */
export const footprint = async (): Promise<readonly number[]> => {
  const rows = await db.admin.execute<{ readonly n: string }>(
    `select count(*)::text as n from public.records where business_id = $1
     union all select count(*)::text from public.record_links where business_id = $1
     union all select count(*)::text from public.audit_events
                where business_id = $1 and command = 'task.duplicate' and outcome = 'applied'`,
    [alpha],
  );
  return rows.map((row) => Number(row.n));
};

/** `task.read` as `member` reads it. */
export const detailOf = async (
  member: Member,
  recordId: string,
): Promise<ReadResult | CommandRefusal> =>
  await executeRead(db.app, alpha, member.presented, { read: 'task.read', recordId });

/** `task.board` for tasks on no board, as `member` reads it. */
export const boardOf = async (member: Member): Promise<ReadResult | CommandRefusal> =>
  await executeRead(db.app, alpha, member.presented, { read: 'task.board', board: null });

/** The new task a duplicate answered with, or the refusal thrown. */
export const newTaskOf = (answer: CommandResult): { taskId: string; key: string } => {
  if (isCommandRefusal(answer)) throw new Error(`duplicate refused ${answer.code}`);
  return answer.detail as { taskId: string; key: string };
};

/** A person of `business` with no grant yet. */
export const person = async (name: string, business: BusinessId = alpha): Promise<Member> =>
  await enrol(db.app, business, `${name}-${randomUUID()}`);

/** The business's `client` record type, and one client record under it. */
async function plantClient(business: BusinessId, name: string, aliases: readonly string[]) {
  const typeKey = 'client';
  await db.admin.execute(
    `insert into public.record_types (business_id, id, key, name, origin)
     values ($1, gen_random_uuid(), $2, 'Client', 'preset') on conflict do nothing`,
    [business, typeKey],
  );
  const id = randomUUID();
  await db.admin.execute(
    `insert into public.records (business_id, id, record_type_id, data)
     select $1, $2, t.id, $3 from public.record_types t where t.business_id = $1 and t.key = $4`,
    [business, id, { name, aliases }, typeKey],
  );
  return id;
}

export async function setUp(): Promise<void> {
  db = await createFreshDatabase({ part: 'h' });
  alpha = (await insertBusiness(db.app, 'dup-alpha')) as BusinessId;
  bravo = (await insertBusiness(db.app, 'dup-bravo')) as BusinessId;
  await installSpine(db.app, alpha);
  await installSpine(db.app, bravo);
  owner = await enrol(db.app, alpha, 'owner');
  bravoWriter = await enrol(db.app, bravo, 'bravo-writer');
  await db.app.withBusiness(alpha, async (tx) => {
    for (const action of ['read', 'write', 'share', 'assign', 'comment'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one transaction, one statement at a time
      await grantTo(tx, owner, action);
    }
    await grantTo(tx, owner, 'write', undefined, false, 'time');
    await grantTo(tx, owner, 'write', undefined, false, 'tag');
  });
  await db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bravoWriter, 'write');
    await grantTo(tx, bravoWriter, 'read');
  });
  clientA = await plantClient(alpha, CLIENT_A_NAME, [CLIENT_A_ALIAS]);
  clientB = await plantClient(alpha, 'Northgate Physio', []);
}

export async function tearDown(): Promise<void> {
  await db?.drop();
}
