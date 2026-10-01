// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared world of the “MP-4-10 client access” cases: the database, the
// people and the helpers they read, set up once per test file that imports it.
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';

import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertPerson,
} from '../identity/fixture.ts';

import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

import { addClient, enrol, grantTo, installSpine, type Member } from './fixture.ts';

import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';

import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';

import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';

import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';

import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';

import type { BusinessId } from '../../packages/core-records/src/index.ts';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

export const CANARY: string = `canary-${randomUUID()}`;

export const SHARE = 'task.share_with_client';

export const REVOKE = 'task.revoke_client_share';

export const outcomeOf: (
  answer: CommandResult | Awaited<ReturnType<typeof executeRead>>,
) => Readonly<Record<string, unknown>> = (
  answer: CommandResult | Awaited<ReturnType<typeof executeRead>>,
) => (isCommandRefusal(answer) ? { code: answer.code, names: answer.names } : { applied: true });

/** The shares a task carries: live record-scoped `task:read` rows, by holder. */
export const SHARES_SQL = `select subject_id as person_id, granted_by_actor_id, revoked_at is null as live
                      from public.grants
                     where scope_kind = 'record' and scope_id = $1 and subject_kind = 'person'
                       and collection = 'task' and action = 'read'
                     order by granted_at`;

export interface ShareRow {
  readonly person_id: string;
  readonly granted_by_actor_id: string;
  readonly live: boolean;
}

export let db: FreshDatabase;

export let alpha: BusinessId;

export let bravo: BusinessId;

export let admin: Member;

export let taskSharer: Member;

export let scopedSharer: Member;

export let reader: Member;

export let bravoAdmin: Member;

export const clientA: string = randomUUID();

export const clientB: string = randomUUID();

export let clientAPeople: Member[];

export let clientBPerson: Member;

export const as: (
  business: BusinessId,
  member: Member,
  body: Record<string, unknown>,
) => Promise<CommandResult> = async (
  business: BusinessId,
  member: Member,
  body: Record<string, unknown>,
) =>
  await executeCommand(db.app, business, member.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);

export const revisionOf: (recordId: string) => Promise<number> = async (recordId: string) =>
  Number(
    (
      await db.admin.execute<{ readonly revision: string }>(
        `select revision::text as revision from public.records where id = $1`,
        [recordId],
      )
    )[0]?.revision,
  );

export const sharesOf: (recordId: string) => Promise<readonly ShareRow[]> = async (
  recordId: string,
) => await db.admin.execute<ShareRow>(SHARES_SQL, [recordId]);

export const liveHolders: (recordId: string) => Promise<string[]> = async (recordId: string) =>
  (await sharesOf(recordId))
    .filter((share) => share.live)
    .map((share) => share.person_id)
    .toSorted();

/** A task with a title, set on a client by the admin through `task.set_party`. */
export const fresh: (
  business: BusinessId,
  by: Member,
  title: string,
  client: string | null,
) => Promise<string> = async (
  business: BusinessId,
  by: Member,
  title: string,
  client: string | null,
): Promise<string> => {
  const made = await as(business, by, { command: 'task.create', fields: { title } });
  if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
  const recordId = made.recordId ?? '';
  if (client !== null) {
    const set = await as(business, by, {
      command: 'task.set_party',
      recordId,
      expectedRevision: await revisionOf(recordId),
      fields: { client },
    });
    if (isCommandRefusal(set)) throw new Error(`set_party refused ${set.code}`);
  }
  return recordId;
};

/**
 * The task put on `client` behind every command's back: the state a command
 * can no longer reach (S0-5 locks a task's client once it has content, and
 * C32 refuses a client of another business), held by older rows all the same.
 */
export const placeBehind = async (recordId: string, client: string): Promise<void> => {
  await db.admin.execute(
    `update public.records set data = jsonb_set(data, '{client}', to_jsonb($2::text))
      where id = $1`,
    [recordId, client],
  );
};

export const toggle: (
  business: BusinessId,
  by: Member,
  command: typeof SHARE | typeof REVOKE,
  recordId: string,
  operationId?: string,
) => Promise<CommandResult> = async (
  business: BusinessId,
  by: Member,
  command: typeof SHARE | typeof REVOKE,
  recordId: string,
  operationId: string = randomUUID(),
) =>
  await as(business, by, {
    command,
    operationId,
    recordId,
    expectedRevision: await revisionOf(recordId),
  });

/**
 * One of a client's existing people: a person with a login and no
 * membership, standing on the client through a party-scoped `task:read`.
 */
export const clientPerson: (
  business: BusinessId,
  client: string,
  by: Member,
) => Promise<Member & { readonly partyGrantId: string }> = async (
  business: BusinessId,
  client: string,
  by: Member,
) =>
  await db.app.withBusiness(business, async (tx) => {
    const subject = `client-person-${randomUUID()}`;
    const personId = await insertPerson(tx, subject);
    const actorId = await insertActor(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, by.actorId);
    const issued = await issueGrant(tx, [], {
      subject: { kind: 'person', id: personId },
      scope: { kind: 'party', id: client },
      collection: 'task',
      action: 'read',
      parentGrantId: null,
      grantedByActorId: by.actorId,
    });
    if (!issued.ok) throw new Error(`clientPerson: refused ${issued.refusal.code}`);
    return {
      personId,
      actorId,
      presented: { provider: 'supabase', subject },
      partyGrantId: issued.value,
    } as Member & { readonly partyGrantId: string };
  });

export const readAs: (
  business: BusinessId,
  member: Member,
  recordId: string,
) => ReturnType<typeof executeRead> = async (
  business: BusinessId,
  member: Member,
  recordId: string,
) => await executeRead(db.app, business, member.presented, { read: 'task.read', recordId });

export const clientAccessOf: (member: Member, recordId: string) => Promise<boolean | null> = async (
  member: Member,
  recordId: string,
) => {
  const read = await readAs(alpha, member, recordId);
  return isCommandRefusal(read) || !('task' in read) ? null : read.task.clientAccess;
};

/** One audit event as the audited-changes case reads it back. */
export interface AuditRow {
  readonly command: string;
  readonly actor_id: string;
  readonly outcome: string;
  readonly refusal_code: string | null;
  readonly subject_record_id: string | null;
}

/** The audit events of these operations in alpha, in chain order. */
export const auditOf = async (operationIds: readonly string[]): Promise<readonly AuditRow[]> =>
  await db.admin.execute<AuditRow>(
    `select command, actor_id, outcome, refusal_code, subject_record_id from public.audit_events
      where business_id = $1 and operation_id = any($2::text[])
      order by seq`,
    [alpha, operationIds],
  );

export async function setUp(): Promise<void> {
  db = await createFreshDatabase({ part: 'hc' });
  alpha = (await insertBusiness(db.app, 'access-alpha')) as BusinessId;
  bravo = (await insertBusiness(db.app, 'access-bravo')) as BusinessId;
  await installSpine(db.app, alpha);
  await installSpine(db.app, bravo);
  admin = await enrol(db.app, alpha, 'admin');
  taskSharer = await enrol(db.app, alpha, 'task-sharer');
  scopedSharer = await enrol(db.app, alpha, 'scoped-sharer');
  reader = await enrol(db.app, alpha, 'reader');
  bravoAdmin = await enrol(db.app, bravo, 'bravo-admin');
  await db.app.withBusiness(alpha, async (tx) => {
    for (const action of ['read', 'write', 'share'] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, admin, action);
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, taskSharer, action);
    }
    await grantTo(tx, admin, 'share', undefined, false, 'access');
    await grantTo(tx, scopedSharer, 'read');
    await grantTo(tx, reader, 'read');
  });
  await db.app.withBusiness(bravo, async (tx) => {
    for (const action of ['read', 'write', 'share'] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, bravoAdmin, action);
    }
    await grantTo(tx, bravoAdmin, 'share', undefined, false, 'access');
  });
  await addClient(db.app, alpha, clientA, admin);
  await addClient(db.app, alpha, clientB, admin);
  clientAPeople = [
    await clientPerson(alpha, clientA, admin),
    await clientPerson(alpha, clientA, admin),
  ];
  clientBPerson = await clientPerson(alpha, clientB, admin);
}

export async function tearDown(): Promise<void> {
  await db?.drop();
}
