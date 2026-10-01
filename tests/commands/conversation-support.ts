// SPDX-License-Identifier: AGPL-3.0-only
//
// The world MP-4-5's server-step suites share: one business with a task on
// client A (shared with one of client A's people, who may comment on it) and
// a task on client B, a colleague who may comment, a reader who may not, and
// a second business with its own admin. Each suite seeds its own copy.

import { randomUUID } from 'node:crypto';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertPerson,
} from '../identity/fixture.ts';
import { addClient, enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { agentWorld, type AgentWorld, type Decider } from './agent-fixture.ts';

export type Body = Readonly<Record<string, unknown>>;
export type Answer = Awaited<ReturnType<typeof executeCommand>>;
export type Row = Readonly<Record<string, unknown>>;

/** Who the conversation suites act as, filled by `seedConversation`. */
export const who = {} as {
  world: AgentWorld;
  decider: Decider;
  colleague: Member;
  reader: Member;
  clientPerson: Member;
  bravoAdmin: Member;
  bravo: string;
};
export const clientA: string = randomUUID();
export const clientB: string = randomUUID();
export const ids: Record<string, string> = {};

export const revision = async (recordId: string): Promise<number> => {
  const rows = await who.world.db.admin.execute<{ readonly revision: string }>(
    `select revision::text as revision from public.records where id = $1`,
    [recordId],
  );
  return Number(rows[0]?.revision);
};

export const as = async (
  member: Member,
  body: Body,
  business: string = who.world.business,
): Promise<Answer> =>
  await executeCommand(who.world.db.app, business as never, member.presented, 'api', {
    operationId: randomUUID(),
    ...body,
  } as never);

export const must = async (
  member: Member,
  body: Body,
  business: string = who.world.business,
): Promise<Answer> => {
  const answer = await as(member, body, business);
  if (isCommandRefusal(answer)) {
    throw new Error(`${String(body['command'])} refused ${answer.code}`);
  }
  return answer;
};

/** The record an applied answer names. */
export const recordOf = (answer: Answer): string =>
  String((answer as { readonly recordId?: unknown }).recordId ?? '');

export const commentIdOf = (answer: Answer): string => {
  if (isCommandRefusal(answer)) throw new Error(`refused ${answer.code}`);
  return String((answer.detail as Row | undefined)?.['commentId'] ?? '');
};

export const post = async (
  member: Member,
  recordId: string,
  audience: string,
  body: string,
  parentId?: string,
  business: string = who.world.business,
): Promise<Answer> =>
  await as(
    member,
    {
      command: 'task.comment',
      recordId,
      expectedRevision: await revision(recordId),
      body,
      audience,
      ...(parentId === undefined ? {} : { parentId }),
    },
    business,
  );

export const edit = async (
  member: Member,
  recordId: string,
  commentId: string,
  body: string,
): Promise<Answer> =>
  await as(member, {
    command: 'task.edit_comment',
    recordId,
    expectedRevision: await revision(recordId),
    commentId,
    body,
  });

export const remove = async (
  member: Member,
  recordId: string,
  commentId: string,
): Promise<Answer> =>
  await as(member, {
    command: 'task.delete_comment',
    recordId,
    expectedRevision: await revision(recordId),
    commentId,
  });

/** A comment row as stored: its body, and whether it was edited or deleted. */
export interface StoredRow {
  readonly body: string | null;
  readonly edited: boolean;
  readonly deleted: boolean;
}

/** The comment row as stored, whoever may read it. */
export const stored = async (commentId: string): Promise<StoredRow | undefined> =>
  (
    await who.world.db.admin.execute<StoredRow>(
      `select data ->> 'body' as body, data ? 'edited_at' and data ->> 'edited_at' is not null as edited,
              deleted_at is not null as deleted
         from public.records where id = $1`,
      [commentId],
    )
  )[0];

/** The comments a member reads on the task page, as `task.read` answers them. */
export const thread = async (member: Member, recordId: string): Promise<readonly Row[]> => {
  const answer = await executeRead(who.world.db.app, who.world.business, member.presented, {
    read: 'task.read',
    recordId,
  });
  if (isCommandRefusal(answer) || !('task' in answer)) {
    throw new Error(`task.read did not answer the task: ${JSON.stringify(answer)}`);
  }
  return answer.task.comments as readonly Row[];
};

export const task = async (client: string, title = 'a task'): Promise<string> => {
  const created = await must(who.decider, { command: 'task.create', fields: { title } });
  const recordId = recordOf(created);
  await must(who.decider, {
    command: 'task.set_party',
    recordId,
    expectedRevision: await revision(recordId),
    fields: { client },
  });
  return recordId;
};

/**
 * One of a client's people: no membership, a party-scoped read on the client,
 * and the record-scoped `task:comment` an outside party (R4) is provisioned
 * on the task it writes on.
 */
export const onClient = async (client: string, taskId: string): Promise<Member> =>
  await who.world.db.app.withBusiness(who.world.business, async (tx) => {
    const subject = `client-person-${randomUUID()}`;
    const personId = await insertPerson(tx, subject);
    const actorId = await insertActor(tx, personId);
    await insertMapping(tx, await insertLogin(tx, subject), personId, who.decider.actorId);
    for (const [scope, action] of [
      [{ kind: 'party', id: client }, 'read'],
      [{ kind: 'record', id: taskId }, 'comment'],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'person', id: personId },
        scope,
        collection: 'task',
        action,
        parentGrantId: null,
        grantedByActorId: who.decider.actorId,
      });
      if (!issued.ok) throw new Error(`onClient: refused ${issued.refusal.code}`);
    }
    return { personId, actorId, presented: { provider: 'supabase', subject } } as Member;
  });

/** One business with two clients’ tasks, the people who act on them, and a second business. */
export async function seedConversation(prefix: string): Promise<void> {
  who.world = await agentWorld(prefix, `conversation-${randomUUID().slice(0, 8)}`);
  who.decider = await who.world.decider('decider');
  who.colleague = await enrol(who.world.db.app, who.world.business, 'colleague');
  who.reader = await enrol(who.world.db.app, who.world.business, 'reader');
  await who.world.db.app.withBusiness(who.world.business, async (tx) => {
    await grantTo(tx, who.decider, 'share');
    await grantTo(tx, who.decider, 'share', undefined, false, 'access');
    await grantTo(tx, who.colleague, 'read');
    await grantTo(tx, who.colleague, 'comment');
    await grantTo(tx, who.reader, 'read');
  });
  await addClient(who.world.db.app, who.world.business, clientA, who.decider);
  await addClient(who.world.db.app, who.world.business, clientB, who.decider);
  ids['a'] = await task(clientA);
  ids['b'] = await task(clientB);
  who.clientPerson = await onClient(clientA, ids['a']);
  await must(who.decider, {
    command: 'task.share_with_client',
    recordId: ids['a'],
    expectedRevision: await revision(ids['a'] ?? ''),
  });
  who.bravo = await insertBusiness(who.world.db.app, `replies-bravo-${randomUUID().slice(0, 8)}`);
  await installSpine(who.world.db.app, who.bravo as never);
  who.bravoAdmin = await enrol(who.world.db.app, who.bravo as never, 'bravo-admin');
  await who.world.db.app.withBusiness(who.bravo as never, async (tx) => {
    for (const action of ['read', 'write', 'comment'] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, who.bravoAdmin, action);
    }
  });
}
