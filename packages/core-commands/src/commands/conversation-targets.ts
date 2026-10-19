// SPDX-License-Identifier: AGPL-3.0-only
//
// #1666: a chat opened on no task edits a task it created.
//
// - The snapshot: the tasks the conversation created that the asker could use
//   (`pageOf`) when the reply was asked, each at the revision read under its
//   share lock. It is kept with the reply in the keep's own transaction, and a
//   retry, a twin request or a recovery reads the kept one back: it is never
//   rebuilt. The tables hold only this conversation's own created tasks
//   (`conversation_reply_targets`' trigger).
// - Delivery: only to the conversation's owner, each target filtered by their
//   read now (not trashed, no client's, `task:read`), keeping its position, so
//   nothing is renumbered. `pick` says whether the conversation had created
//   more than one task, so a filter that leaves one still asks the person to
//   choose.
// - Sources: the tasks an earlier exchange may carry, those its card wrote
//   (`task-proposal:<reply id>` in the audit chain) and those its snapshot
//   held. The context leaves out the first exchange, by its question's place,
//   with a source the asker can no longer use, and every exchange after it
//   (`conversation-context.ts`), whatever order the replies finished in.

import type { ConversationTargetsView } from '../../../core-wire/src/index.ts';
import {
  heldScopes,
  slotOf,
  subjectsOf,
  TASK_SPINE,
  type Session,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import { createdTasks } from './conversation-work.ts';

/** One created task as the reply's question saw it. */
export interface Target {
  readonly taskId: string;
  readonly revision: number;
}

/** What the reply is kept with: how many tasks the conversation had created, and those usable, by position. */
export interface Snapshot {
  readonly created: number;
  readonly tasks: readonly (Target & { readonly n: number })[];
}

const CLIENT = slotOf(TASK_SPINE, 'client');

/** The prefix of a card's operation id (`task-proposal.ts` `operationOf`). */
const CARD_OPERATION = 'task-proposal:';

/** The snapshot, kept beside the reply `messageId` just inserted. */
export async function keepSnapshot(
  tx: TenantQuery,
  messageId: string,
  snapshot: Snapshot,
): Promise<void> {
  await tx.query(
    `insert into conversation_reply_snapshots (business_id, message_id, created)
     values ($1, $2, $3)`,
    [tx.businessId, messageId, snapshot.created],
  );
  if (snapshot.tasks.length === 0) return;
  await tx.query(
    `insert into conversation_reply_targets (business_id, message_id, position, task_id, revision)
     select $1, $2, t.position, t.task_id, t.revision
       from unnest($3::int[], $4::uuid[], $5::bigint[]) as t (position, task_id, revision)`,
    [
      tx.businessId,
      messageId,
      snapshot.tasks.map((task) => task.n),
      snapshot.tasks.map((task) => task.taskId),
      snapshot.tasks.map((task) => task.revision),
    ],
  );
}

/** The tasks among `ids` the caller may read now, through a business-wide or record grant. */
export async function readable(
  tx: TenantQuery,
  session: Session,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set();
  const scopes = await heldScopes(tx, subjectsOf(session), { collection: 'task', action: 'read' });
  if (scopes.some((scope) => scope.kind === 'business')) return new Set(ids);
  const records = new Set(scopes.flatMap((scope) => (scope.kind === 'record' ? [scope.id] : [])));
  return new Set(ids.filter((id) => records.has(id)));
}

interface TargetRow {
  readonly message_id: string;
  readonly created: number;
  readonly n: number | null;
  readonly task_id: string | null;
  readonly revision: string | null;
}

/**
 * The kept snapshots of the replies `messageIds`, as the caller may have
 * them: none unless they own the conversation, and each target only while
 * they may use it. A reply kept with no snapshot has none.
 */
export async function targetsFor(
  tx: TenantQuery,
  session: Session,
  messageIds: readonly string[],
): Promise<ReadonlyMap<string, ConversationTargetsView>> {
  if (messageIds.length === 0) return new Map();
  const rows = await tx.query<TargetRow>(
    `select s.message_id, s.created, t.position as n, t.task_id, t.revision::text as revision
       from conversation_reply_snapshots s
       join conversation_messages m on m.business_id = s.business_id and m.id = s.message_id
       join conversations c on c.business_id = m.business_id and c.id = m.conversation_id
       left join conversation_reply_targets t
         on t.business_id = s.business_id and t.message_id = s.message_id
        and exists (select 1 from records r
                     where r.business_id = t.business_id and r.id = t.task_id
                       and r.deleted_at is null and r.${CLIENT} is null)
      where s.business_id = $1 and s.message_id = any($2::uuid[]) and c.owner_actor_id = $3
      order by s.message_id, t.position`,
    [tx.businessId, messageIds, session.actorId],
  );
  const reads = await readable(
    tx,
    session,
    rows.flatMap((row) => (row.task_id === null ? [] : [row.task_id])),
  );
  const out = new Map<
    string,
    { pick: boolean; tasks: ConversationTargetsView['tasks'][number][] }
  >();
  for (const row of rows) {
    const view = out.get(row.message_id) ?? { pick: row.created > 1, tasks: [] };
    out.set(row.message_id, view);
    if (row.task_id === null || row.n === null || !reads.has(row.task_id)) continue;
    view.tasks.push({ n: row.n, taskId: row.task_id, revision: Number(row.revision) });
  }
  return out;
}

/** An earlier exchange of the conversation's current epoch: where it starts, and its sources. */
interface Sourced {
  /** The exchange's question, or the reply itself where it answers none. */
  readonly from: string;
  readonly sources: readonly string[];
}

/**
 * The tasks each reply of the current epoch may carry, those its card wrote
 * and those its snapshot held, in its question's order: replies to queued
 * questions can finish in either order.
 */
async function sourcesOf(tx: TenantQuery, conversationId: string): Promise<readonly Sourced[]> {
  const rows = await tx.query<{ readonly from_id: string; readonly task_id: string }>(
    `select f.id as from_id, s.task_id
       from conversation_messages m
       join conversations c on c.business_id = m.business_id and c.id = m.conversation_id
       join conversation_messages f
         on f.business_id = m.business_id and f.id = coalesce(m.answers_message_id, m.id)
       join lateral (
         select a.subject_record_id as task_id from audit_events a
          where a.business_id = m.business_id and a.operation_id = $3 || m.id::text
            and a.command in ('task.create', 'task.update') and a.outcome = 'applied'
            and a.subject_record_id is not null
         union
         select t.task_id from conversation_reply_targets t
          where t.business_id = m.business_id and t.message_id = m.id
       ) s on true
      where m.business_id = $1 and m.conversation_id = $2 and m.role = 'agent'
        and m.context_epoch = c.context_epoch
      order by f.created_at, f.id, s.task_id`,
    [tx.businessId, conversationId, CARD_OPERATION],
  );
  const byExchange = new Map<string, string[]>();
  for (const row of rows) {
    const sources = byExchange.get(row.from_id) ?? [];
    sources.push(row.task_id);
    byExchange.set(row.from_id, sources);
  }
  return [...byExchange].map(([from, sources]) => ({ from, sources }));
}

/** What the context reads of the conversation's created work. */
export interface Created {
  /** On no page, the created tasks as the reply is kept with them; else null. */
  readonly snapshot: Snapshot | null;
  /** The first exchange left out of history, with every one after it; null for none. */
  readonly cut: string | null;
  /** The tasks the exchanges kept in history may carry: judged again at a paid or carried handoff. */
  readonly sources: readonly string[];
}

export const NO_CREATED: Created = { snapshot: null, cut: null, sources: [] };

/**
 * The conversation's created tasks and its earlier exchanges' sources, each
 * judged once by `judge` (as a page is: its row when usable, else why not),
 * in id order, so the share locks are taken in one order. The first exchange
 * with a source that fails is the cut.
 */
export async function createdOf(
  tx: TenantQuery,
  conversationId: string,
  scoped: boolean,
  judge: (taskId: string) => Promise<{ readonly revision: string } | string>,
): Promise<Created> {
  const created = scoped ? [] : await createdTasks(tx, conversationId);
  const sourced = await sourcesOf(tx, conversationId);
  const ids = [...created.map((task) => task.id), ...sourced.flatMap((one) => one.sources)];
  const judged = new Map<string, { readonly revision: string } | string>();
  for (const id of [...new Set(ids)].toSorted()) {
    // eslint-disable-next-line no-await-in-loop -- one lock after another, in id order
    judged.set(id, await judge(id));
  }
  const usable = (id: string): boolean => typeof judged.get(id) === 'object';
  const cutAt = sourced.findIndex((exchange) => !exchange.sources.every(usable));
  const kept = cutAt < 0 ? sourced : sourced.slice(0, cutAt);
  const tasks = created.flatMap((task, at) => {
    const row = judged.get(task.id);
    return typeof row === 'object'
      ? [{ n: at + 1, taskId: task.id, revision: Number(row.revision) }]
      : [];
  });
  return {
    snapshot: created.length === 0 ? null : { created: created.length, tasks },
    cut: sourced[cutAt]?.from ?? null,
    sources: [...new Set(kept.flatMap((exchange) => exchange.sources))],
  };
}
