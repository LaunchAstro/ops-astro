// SPDX-License-Identifier: AGPL-3.0-only
//
// C57 part B's world (#2117), on part A's: a client pin on task A's review filed and decided,
// and the agent's live worker lease on task A itself, taken through `task.propose`,
// `task.decide` and `task.pickup` as the runtime takes one. The worker makes the approved
// request's task under that lease (`review.make_change_task`).

import { randomUUID } from 'node:crypto';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { detailOf } from '../commands/agent-fixture.ts';
import { c57World, type C57World } from './c57-world.ts';

export interface WorkerLease {
  readonly leaseId: string;
  readonly fence: number;
  readonly credential: string;
}

export interface C57bWorld extends C57World {
  /** The agent's live lease on `taskId` (task A unless told). */
  leaseOn(taskId?: string): Promise<WorkerLease>;
  /** A client pin on task A's review filed by ava, and decided by her when `decision` is given. */
  filed(decision?: 'approve' | 'refuse', text?: string): Promise<string>;
  make(lease: WorkerLease, changeRequestId: unknown, extra?: Body): Promise<CommandResult>;
  /** A live task's data and parent, as the administrator reads it. */
  taskRow(id: string): Promise<TaskRow | undefined>;
}

export interface TaskRow {
  readonly data: Readonly<Record<string, unknown>>;
  readonly business_id: string;
}

type Body = Readonly<Record<string, unknown>>;

function need(result: CommandResult, what: string): Readonly<Record<string, unknown>> {
  if (isCommandRefusal(result)) throw new Error(`c57bWorld: ${what} refused ${result.code}`);
  return detailOf(result);
}

/** The agent's live lease on `taskId`, proposed and approved by ava and picked up. */
async function workerLease(w: C57World, taskId: string): Promise<WorkerLease> {
  const [task] = await w.world.db.admin.execute<{ readonly revision: string }>(
    'select revision::text as revision from public.records where id = $1',
    [taskId],
  );
  const proposed = need(
    await w.as(w.ava, {
      command: 'task.propose',
      recordId: taskId,
      expectedRevision: Number(task?.revision),
      purpose: `draft_${randomUUID().slice(0, 8)}`,
      maximumMinor: 3_000,
      currency: 'AUD',
      payload: { instruction: 'make the approved change request a task' },
      step: { kind: 'compose', payload: {} },
    }),
    'task.propose',
  );
  const decided = need(
    await w.as(w.ava, {
      command: 'task.decide',
      gateId: proposed['gateId'],
      versionId: proposed['versionId'],
      decision: 'approve',
      note: 'approved so the worker can make the task',
    }),
    'task.decide',
  );
  const picked = need(
    await w.world.asAgent({
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: decided['reservationId'],
    }),
    'task.pickup',
  );
  return {
    leaseId: String(picked['leaseId']),
    fence: Number(picked['fence']),
    credential: String(picked['credential']),
  };
}

export async function c57bWorld(part: string): Promise<C57bWorld> {
  const w = await c57World(part);
  return {
    ...w,
    leaseOn: async (taskId = w.taskA) => await workerLease(w, taskId),
    async filed(decision, text) {
      const { clientPin } = await w.pins();
      const id = String(
        need(await w.propose(w.ava, clientPin, text === undefined ? {} : { text }), 'propose')[
          'changeRequestId'
        ],
      );
      if (decision !== undefined) need(await w.decide(w.ava, id, decision), 'decide');
      return id;
    },
    // Each call on a connection of its own, as the agent's calls arrive: two at once race in
    // Postgres rather than queueing on the world's one-connection pool.
    async make(lease, changeRequestId, extra = {}) {
      const own = connect(w.world.db.appUrl);
      try {
        return await executeAgentCommand(
          own,
          w.world.business,
          { provider: 'supabase', subject: w.world.agentSubject() },
          lease.credential,
          {
            command: 'review.make_change_task',
            operationId: randomUUID(),
            leaseId: lease.leaseId,
            fence: lease.fence,
            changeRequestId,
            ...extra,
          } as never,
        );
      } finally {
        await own.close();
      }
    },
    taskRow: async (id) =>
      (
        await w.world.db.admin.execute<TaskRow>(
          'select data, business_id from public.records where id = $1 and deleted_at is null',
          [id],
        )
      )[0],
  };
}
