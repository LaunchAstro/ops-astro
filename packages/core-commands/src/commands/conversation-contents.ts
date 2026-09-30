// SPDX-License-Identifier: AGPL-3.0-only
//
// What a conversation's wrap-up holds (AW-03), read from records and never
// from the transcript: the work it cited or started, with each item's state
// and when it ended; the seven pointer-and-fact items; and the request, the
// first message as a marked quotation. `conversation-lifecycle.ts` writes
// them at quiet and reads the work again before a purge.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { ConversationPointerView, WrapUpItemView } from '../../../core-wire/src/index.ts';
import { conversationAddress } from './conversations.ts';

const QUOTATION_LIMIT = 1_000;

/** A conversation as its row lock read it. */
export interface Locked {
  readonly owner_actor_id: string;
  readonly scope_record_id: string | null;
  readonly created_at: Date;
  readonly last_activity_at: Date;
  readonly body_purged_at: Date | null;
  readonly purge_operation_id: string | null;
  readonly quiet: boolean;
}

/** The work the conversation cited or started, each with whether it has ended and when. */
export interface Work {
  readonly pointer: ConversationPointerView;
  readonly terminal: boolean;
  readonly endedAt: Date | null;
}

interface TaskRow {
  readonly id: string;
  readonly category: string | null;
  readonly completed_at: Date | null;
  readonly updated_at: Date;
}

/** The task the conversation was opened on, with its state; a completed task ended at its stamp. */
async function taskWork(tx: TenantQuery, scopeRecordId: string | null): Promise<readonly Work[]> {
  if (scopeRecordId === null) return [];
  const tasks = await tx.query<TaskRow>(
    `select r.id, s.data ->> 'machine_category' as category, r.ts_2 as completed_at,
            r.updated_at
       from records r
       left join records s
         on s.business_id = r.business_id and s.id = r.uuid_1 and s.deleted_at is null
      where r.business_id = $1 and r.id = $2`,
    [tx.businessId, scopeRecordId],
  );
  return tasks.map((task) => {
    const terminal = task.category === 'completed' || task.category === 'cancelled';
    return {
      pointer: {
        kind: 'task',
        id: task.id,
        address: `/task/${task.id}`,
        state: task.category ?? 'unknown',
      },
      terminal,
      endedAt: terminal ? (task.completed_at ?? task.updated_at) : null,
    };
  });
}

/** The runs and gates the conversation started, each pointing at its task. */
async function startedWork(tx: TenantQuery, conversationId: string): Promise<readonly Work[]> {
  const runs = await tx.query<{ id: string; task_id: string; state: string }>(
    `select id, task_id, state from planned_runs
      where business_id = $1 and origin_conversation_id = $2 order by id`,
    [tx.businessId, conversationId],
  );
  const gates = await tx.query<{ id: string; task_id: string; state: string }>(
    `select g.id, l.task_id, g.state from gates g
       join proposal_lineages l on l.business_id = g.business_id and l.id = g.lineage_id
      where g.business_id = $1 and g.origin_conversation_id = $2 order by g.id`,
    [tx.businessId, conversationId],
  );
  return [
    ...runs.map((run): Work => ({
      pointer: { kind: 'run', id: run.id, address: `/task/${run.task_id}`, state: run.state },
      terminal: run.state === 'handed_back' || run.state === 'cancelled',
      endedAt: null,
    })),
    ...gates.map((gate): Work => ({
      pointer: { kind: 'gate', id: gate.id, address: `/task/${gate.task_id}`, state: gate.state },
      terminal: gate.state !== 'pending',
      endedAt: null,
    })),
  ];
}

export async function workOf(
  tx: TenantQuery,
  conversationId: string,
  scopeRecordId: string | null,
): Promise<readonly Work[]> {
  return [...(await taskWork(tx, scopeRecordId)), ...(await startedWork(tx, conversationId))];
}

const pointersOf = (
  work: readonly Work[],
  kind: ConversationPointerView['kind'],
): readonly ConversationPointerView[] =>
  work.filter((item) => item.pointer.kind === kind).map((item) => item.pointer);

/** The seven pointer-and-fact contents, from records. */
export async function itemsOf(
  tx: TenantQuery,
  conversationId: string,
  locked: Pick<Locked, 'created_at' | 'last_activity_at'>,
  work: readonly Work[],
): Promise<readonly WrapUpItemView[]> {
  const counts = await tx.query<{ n: string; first: Date; last: Date }>(
    `select count(*)::text as n, min(created_at) as first, max(created_at) as last
       from conversation_messages where business_id = $1 and conversation_id = $2`,
    [tx.businessId, conversationId],
  );
  const exchange = counts[0];
  const self: ConversationPointerView = {
    kind: 'conversation',
    id: conversationId,
    address: conversationAddress(conversationId),
  };
  const tasks = pointersOf(work, 'task');
  const runs = pointersOf(work, 'run');
  const gates = pointersOf(work, 'gate');
  return [
    {
      key: 'opened',
      fact: `Opened ${locked.created_at.toISOString()} by its owner`,
      pointers: [self],
    },
    {
      key: 'scope',
      fact: tasks.length === 0 ? 'Opened with no scope' : 'Opened on a task',
      pointers: tasks,
    },
    {
      key: 'exchange',
      fact: `${exchange?.n ?? '0'} messages, last ${locked.last_activity_at.toISOString()}`,
      pointers: [],
    },
    // The task's creation audit event names its conversation once task.create
    // carries one; until then no task records this conversation as its origin.
    { key: 'tasks_created', fact: 'No task records this conversation as its origin', pointers: [] },
    { key: 'runs_started', fact: `${String(runs.length)} runs started`, pointers: runs },
    { key: 'gates_raised', fact: `${String(gates.length)} gates raised`, pointers: gates },
    // Priced model calls go through AW-01's broker; the conversation's own
    // calls are counted here once the exchange makes them.
    { key: 'cost', fact: 'No priced model call recorded', pointers: [] },
  ];
}

export async function requestQuotation(tx: TenantQuery, conversationId: string): Promise<string> {
  const rows = await tx.query<{ body: string }>(
    `select body from conversation_messages
      where business_id = $1 and conversation_id = $2 and role = 'person'
      order by created_at, id limit 1`,
    [tx.businessId, conversationId],
  );
  const body = rows[0]?.body ?? '';
  return body.length <= QUOTATION_LIMIT ? body : `${body.slice(0, QUOTATION_LIMIT - 1)}…`;
}
