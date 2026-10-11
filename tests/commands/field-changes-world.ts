// SPDX-License-Identifier: AGPL-3.0-only
//
// P20 (U115): what the field-change cases share. A task made and changed
// through the command envelope, and the audit rows read back as stored.

import { randomUUID } from 'node:crypto';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';

export interface Made {
  readonly recordId: string;
  readonly revision: number;
}

/** The applied answer's task, or the refusal thrown: for setup steps. */
export function made(result: CommandResult): Made {
  if (isCommandRefusal(result)) throw new Error(`setup refused ${result.code}`);
  if (result.recordId === null || result.revision === null) throw new Error('setup has no task');
  return { recordId: result.recordId, revision: result.revision };
}

export type UpdateBody = {
  readonly command: 'task.update';
  readonly operationId: string;
  readonly recordId: string;
  readonly expectedRevision: number;
  readonly fields: Readonly<Record<string, unknown>>;
};

/** A `task.update` body against the task as it stands, under a fresh operation id. */
export function update(task: Made, fields: Readonly<Record<string, unknown>>): UpdateBody {
  return {
    command: 'task.update',
    operationId: randomUUID(),
    recordId: task.recordId,
    expectedRevision: task.revision,
    fields,
  };
}

export interface StoredEvent {
  readonly business_id: string;
  readonly outcome: string;
  readonly command: string;
  readonly field_changes: unknown;
  /** The whole row as jsonb, for reading what else it holds. */
  readonly row: Readonly<Record<string, unknown>>;
}

/** Every audit event of these operations, in any business, in chain order. */
export async function eventsOf(
  admin: AdminConnection,
  operationIds: readonly string[],
): Promise<readonly StoredEvent[]> {
  return await admin.execute<StoredEvent>(
    `select business_id::text, outcome, command, field_changes, to_jsonb(a) as row
       from public.audit_events a
      where operation_id = any($1::text[])
      order by business_id, seq`,
    [operationIds],
  );
}

/** The task row as stored. */
export async function taskRow(
  admin: AdminConnection,
  recordId: string,
): Promise<Readonly<Record<string, unknown>>> {
  const rows = await admin.execute<{ readonly row: Readonly<Record<string, unknown>> }>(
    'select to_jsonb(r) as row from public.records r where id = $1',
    [recordId],
  );
  const row = rows[0]?.row;
  if (row === undefined) throw new Error('task row missing');
  return row;
}

/** How many register rows hold this operation. */
export async function operationsOf(admin: AdminConnection, operationId: string): Promise<number> {
  const rows = await admin.execute<{ readonly n: number }>(
    'select count(*)::int as n from public.operations where operation_id = $1',
    [operationId],
  );
  return Number(rows[0]?.n);
}
