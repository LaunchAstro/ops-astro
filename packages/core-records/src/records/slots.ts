// SPDX-License-Identifier: AGPL-3.0-only
//
// The slot catalogue, read from the database rather than declared here.
//
// Two facts make up a slot: that the column exists and what the core reserved
// it for, which `ops.slots` records; and whether it carries an index, which
// only `pg_index` knows. This module reads both from the catalogue for the
// same reason T1a's conformance set does — a registry that claims an index the
// server does not have is worse than no registry, because the promise a slot
// makes is that filtering on it is fast.

import type { AdminConnection } from '../tenancy/database.ts';

export type SlotValueType = 'uuid' | 'text' | 'timestamptz' | 'numeric' | 'boolean';

/** The record types the core reserves slots for. `null` is free for a preset. */
export type SlotReservation = 'task_spine';

export interface Slot {
  readonly slot: string;
  readonly valueType: SlotValueType;
  /** Null means free for a preset field; a name means the core holds it. */
  readonly reservation: SlotReservation | null;
  /** Read from the catalogue. A slot with no index cannot be assigned. */
  readonly indexed: boolean;
}

type Read = AdminConnection['execute'];

interface SlotRow {
  readonly slot: string;
  readonly value_type: SlotValueType;
  readonly reservation: SlotReservation | null;
  readonly indexed: boolean;
}

/**
 * The slot table as the server has it. The index test asks whether any index
 * on `records` mentions the slot column at all, rather than looking for an
 * index of an expected name, so a later migration is free to index a slot
 * differently without this quietly reporting it as unindexed.
 */
export async function readSlotTable(read: Read): Promise<readonly Slot[]> {
  const rows = await read<SlotRow>(
    `select s.slot,
            s.value_type,
            s.reservation,
            exists (
              select 1
                from pg_index x
                join pg_class t on t.oid = x.indrelid
                join pg_namespace n on n.oid = t.relnamespace
                join pg_attribute a
                  on a.attrelid = t.oid and a.attnum = any (x.indkey)
               where n.nspname = 'public'
                 and t.relname = 'records'
                 and a.attname = s.slot
            ) as indexed
       from ops.slots s
      order by s.value_type, length(s.slot), s.slot`,
  );
  return rows.map((row) => ({
    slot: row.slot,
    valueType: row.value_type,
    reservation: row.reservation,
    indexed: row.indexed,
  }));
}

/** The slot columns `records` actually has, for the assertion that the two agree. */
export async function readSlotColumns(
  read: Read,
): Promise<readonly { readonly column: string; readonly type: string }[]> {
  return await read(
    `select column_name as column, data_type as type
       from information_schema.columns
      where table_schema = 'public'
        and table_name = 'records'
        and column_name ~ '^(uuid|txt|ts|num|bool)_[0-9]+$'
      order by column_name`,
  );
}

/** The prefix a slot of each type carries. The name is the type, checked by both schemas. */
export const SLOT_PREFIX: Readonly<Record<SlotValueType, string>> = {
  uuid: 'uuid_',
  text: 'txt_',
  timestamptz: 'ts_',
  numeric: 'num_',
  boolean: 'bool_',
};

/** The SQL type each slot value type is stored as, for the agreement assertion. */
export const SLOT_SQL_TYPE: Readonly<Record<SlotValueType, string>> = {
  uuid: 'uuid',
  text: 'text',
  timestamptz: 'timestamp with time zone',
  numeric: 'numeric',
  boolean: 'boolean',
};

export function slotValueType(slot: string): SlotValueType | undefined {
  for (const [type, prefix] of Object.entries(SLOT_PREFIX)) {
    if (slot.startsWith(prefix)) return type as SlotValueType;
  }
  return undefined;
}

function slotNumber(slot: string): number {
  return Number(slot.slice(slot.indexOf('_') + 1));
}

/** Lowest number first, so assignment is deterministic and a diff is readable. */
export function bySlotNumber(left: Slot, right: Slot): number {
  return slotNumber(left.slot) - slotNumber(right.slot);
}
