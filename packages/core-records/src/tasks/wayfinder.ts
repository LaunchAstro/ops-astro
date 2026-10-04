// SPDX-License-Identifier: AGPL-3.0-only
//
// Wayfinder facts about a task (WF-1). A map is a task of type `map`; its
// tickets are its subtasks. There is no map record type, so what makes a task
// part of a map is read here from the task and its parent, once, for every
// caller that has to ask: the commands, the reads and the share path.

import type { TenantQuery } from '../tenancy/database.ts';
import { TASK_TYPE_KEY } from './spine.ts';

/** The ticket types, in the order the owner named them (W3, #602). */
export const TASK_TYPES = ['map', 'research', 'prototype', 'grilling', 'task', 'build'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** A retype to or from one of these is the map owner's, under `task:decide`. */
export const OWNER_TYPES: ReadonlySet<string> = new Set(['map', 'grilling', 'prototype']);

export function isTaskType(value: unknown): value is TaskType {
  return typeof value === 'string' && (TASK_TYPES as readonly string[]).includes(value);
}

export interface WayfinderFacts {
  readonly type: TaskType;
  /** The map this task belongs to: itself when it is a map, else its parent when that is one. */
  readonly mapId: string | null;
  /** The governing map's owner, a person. */
  readonly mapOwner: string | null;
  readonly client: string | null;
  /** A map or a ticket of one: never on a client surface. */
  readonly wayfinder: boolean;
}

interface FactsRow {
  readonly type: string | null;
  readonly owner: string | null;
  readonly client: string | null;
  readonly parent_id: string | null;
  readonly parent_type: string | null;
  readonly parent_owner: string | null;
}

/**
 * The facts for one live or trashed task of this business, or undefined when
 * the id names no task here. One query, reading the task and its parent.
 * `hold` reads the task `for share`, so no write moves it until the
 * transaction ends.
 */
export async function wayfinderFacts(
  tx: TenantQuery,
  recordId: string,
  hold = false,
): Promise<WayfinderFacts | undefined> {
  const rows = await tx.query<FactsRow>(
    `select r.data ->> 'type' as type, r.data ->> 'map_owner' as owner,
            r.data ->> 'client' as client, p.id as parent_id,
            p.data ->> 'type' as parent_type, p.data ->> 'map_owner' as parent_owner
       from public.records r
       join public.record_types t
         on t.business_id = r.business_id and t.id = r.record_type_id and t.key = $3
       left join public.records p
         on p.business_id = r.business_id and p.id = r.uuid_4 and p.record_type_id = r.record_type_id
      where r.business_id = $1 and r.id = $2${hold ? ' for share of r' : ''}`,
    [tx.businessId, recordId, TASK_TYPE_KEY],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  const type: TaskType = isTaskType(row.type) ? row.type : 'task';
  const parentIsMap = row.parent_type === 'map';
  const mapId = type === 'map' ? recordId : parentIsMap ? row.parent_id : null;
  const mapOwner = type === 'map' ? row.owner : parentIsMap ? row.parent_owner : null;
  return {
    type,
    mapId,
    mapOwner,
    client: row.client,
    wayfinder: type !== 'task' || parentIsMap,
  };
}

/**
 * Whether this task is a map or a map's ticket; false for an id that names no
 * task. `hold` takes the task `for share` first and reads after it, so a retype
 * or move holding the task commits before the answer is read.
 */
export async function isWayfinderRecord(
  tx: TenantQuery,
  recordId: string,
  hold = false,
): Promise<boolean> {
  if (hold) await wayfinderFacts(tx, recordId, true);
  return (await wayfinderFacts(tx, recordId))?.wayfinder ?? false;
}

/**
 * `isWayfinderRecord` as a condition on the task row `alias`, for a query that
 * filters inside itself: a typed task, or a task filed under a map.
 */
export function wayfinderCondition(alias: string): string {
  const typed = TASK_TYPES.filter((type) => type !== 'task').map((type) => `'${type}'`);
  return `(coalesce(${alias}.data ->> 'type', 'task') in (${typed.join(', ')})
    or exists (select 1 from public.records wp
                where wp.business_id = ${alias}.business_id and wp.id = ${alias}.uuid_4
                  and wp.record_type_id = ${alias}.record_type_id and wp.data ->> 'type' = 'map'))`;
}
