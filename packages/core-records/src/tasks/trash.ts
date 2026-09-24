// SPDX-License-Identifier: AGPL-3.0-only
//
// Trash, restore and purge — two different problems the legacy solved in one
// column, kept apart here (specification, 14.3).
//
// **Trash** is a batch. One act stamps one batch identity across a subtree
// root and every descendant not already trashed, and a restore takes a batch
// identity and returns exactly the rows carrying it. So a subtree trashed and
// restored does not resurrect a child somebody deleted last week: that child
// kept its own earlier batch and is not in this one.
//
// **Retention** is a class on the record type, and the purge operation refuses
// to name anything outside the work class. The evidence class is never purged,
// and the refusal is written before the evidence tables exist, because a purge
// that learns about evidence later has already run once.
//
// Neither function writes an audit event, because `audit_events` is T1f's.
// Both return the identifiers they touched so the command that called them can
// write one; a purge with no audit event is the thing 14.3 forbids, and saying
// so here is better than a silent gap.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { refuse, type RecordsRefusal } from '../records/refusals.ts';
import { slotOf, TASK_SPINE } from './spine.ts';

const PARENT = slotOf(TASK_SPINE, 'parent');

export type RetentionClass = 'work' | 'evidence' | 'runtime';

/**
 * What each table of the first slice retains like.
 *
 * Only the work class is purgeable, so this register is deliberately short:
 * naming a table is how it becomes purgeable, and a table nobody classified is
 * refused rather than assumed safe. `audit_events` and `gate_decisions` are
 * listed before they exist, so the refusal is already true when they arrive.
 * The runtime tables follow the work class for their payloads and the evidence
 * class for their digests, which is a split this slice does not build, so they
 * are listed as runtime and refused.
 */
export const RETENTION_CLASS_BY_TABLE: Readonly<Record<string, RetentionClass>> = {
  records: 'work',
  record_links: 'work',
  record_unique_values: 'work',
  audit_events: 'evidence',
  gate_decisions: 'evidence',
  runs: 'runtime',
  steps: 'runtime',
  run_events: 'runtime',
};

/**
 * The purge operation's first refusal: a table it may not name at all.
 *
 * An unregistered table is refused as well as a protected one. A purge that
 * silently accepts a table nobody classified would treat "we have not decided"
 * as "work", which is the direction that loses evidence.
 */
export function refusePurgeOfTable(table: string): RecordsRefusal | undefined {
  const retention = RETENTION_CLASS_BY_TABLE[table];
  if (retention === 'work') return undefined;
  if (retention === undefined) {
    return refuse(
      'RETENTION_CLASS_PROTECTED',
      [table, 'unclassified'],
      [
        'No retention class is recorded for this table, so the purge will not touch it.',
        'Classify it in the retention register before purging it.',
      ],
    );
  }
  return refuse(
    'RETENTION_CLASS_PROTECTED',
    [table, retention],
    [
      `${table} is in the ${retention} class and is never purged by this operation.`,
      'Evidence is append-only, one chain per business, with UPDATE and DELETE revoked.',
    ],
  );
}

export interface TrashResult {
  readonly batchId: string;
  readonly recordIds: readonly string[];
}

interface RootRow {
  readonly deleted_at: Date | null;
  readonly trash_batch_id: string | null;
}

/**
 * Trash one subtree under one batch identity.
 *
 * The walk is a recursive query over the parent slot and it only follows rows
 * that are not already trashed, so an earlier batch is not swallowed by a
 * later one — in the walk **or** in the update. A descendant trashed last week
 * keeps its own batch and stays out of this one, which is what makes a restore
 * of this batch mean something.
 *
 * The walk is read before anything is written, and `authorise` sees every
 * record it found. A grant on the root is not a grant on its descendants: a
 * record-scoped grant matches its own record only (`authority/grants.ts`), so
 * the caller decides whether this caller reaches the whole walk, and a denial
 * comes back as `{ denied }` with nothing trashed. The ids stay with the
 * caller; a refusal that counted or named them would tell someone outside
 * their grant what lies below the root.
 */
export async function trashSubtree(
  tx: TenantQuery,
  options: { readonly rootId: string; readonly actorId: string },
): Promise<TrashResult | RecordsRefusal>;
export async function trashSubtree<Denied>(
  tx: TenantQuery,
  options: {
    readonly rootId: string;
    readonly actorId: string;
    readonly authorise: (recordIds: readonly string[]) => Promise<Denied | undefined>;
  },
): Promise<TrashResult | RecordsRefusal | { readonly denied: Denied }>;
export async function trashSubtree<Denied>(
  tx: TenantQuery,
  options: {
    readonly rootId: string;
    readonly actorId: string;
    readonly authorise?: (recordIds: readonly string[]) => Promise<Denied | undefined>;
  },
): Promise<TrashResult | RecordsRefusal | { readonly denied: Denied }> {
  const root = await tx.query<RootRow>(
    `select deleted_at, trash_batch_id from records where business_id = $1 and id = $2`,
    [tx.businessId, options.rootId],
  );
  const row = root[0];
  if (row === undefined) {
    return refuse('NOT_FOUND', ['record'], ['No record carries that identifier in this business.']);
  }
  if (row.deleted_at !== null) {
    return refuse(
      'ALREADY_TRASHED',
      ['record', row.trash_batch_id ?? ''],
      [
        'This record is already in the trash, in the batch named here.',
        'Restore that batch first if you meant to trash a larger subtree.',
      ],
    );
  }

  const walked = await tx.query<{ readonly id: string }>(
    // `cycle` is not decoration. `parent` is an ordinary uuid slot with no
    // foreign key to itself, so nothing in the schema stops `task.reparent`
    // from producing a loop, and a recursive query over a loop does not
    // return — it runs until the server runs out of something. The clause
    // stops the walk at a record it has already seen. The record-type filter
    // is the same argument: the walk should follow tasks, not whatever else
    // happens to carry a value in that column.
    `with recursive subtree as (
        select id, record_type_id from records
         where business_id = $1 and id = $2 and deleted_at is null
        union all
        select child.id, child.record_type_id from records child
          join subtree on child.${PARENT} = subtree.id
         where child.business_id = $1
           and child.record_type_id = subtree.record_type_id
           and child.deleted_at is null
      ) cycle id set looped using path
      select distinct id from subtree where not looped`,
    [tx.businessId, options.rootId],
  );
  const ids = walked.map((each) => each.id);
  const denied = await options.authorise?.(ids);
  if (denied !== undefined) return { denied };

  const batchId = randomUUID();
  const trashed = await tx.query<{ readonly id: string }>(
    `update records set deleted_at = now(), deleted_by_actor_id = $3, trash_batch_id = $4
      where business_id = $1 and id = any ($2::uuid[]) and deleted_at is null
      returning id`,
    [tx.businessId, ids, options.actorId, batchId],
  );
  return { batchId, recordIds: trashed.map((each) => each.id) };
}

export interface RestoreResult {
  readonly batchId: string;
  readonly recordIds: readonly string[];
}

interface BatchRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly parent_deleted: boolean | null;
  readonly parent_batch: string | null;
}

/**
 * Restore exactly the rows carrying one batch identity.
 *
 * Two refusals stand in front of the write, and both are checks rather than
 * caught exceptions. A refusal produced by rescuing a constraint violation
 * needs a savepoint and leaves the caller's transaction in a state nobody
 * asked for; a check answers the same question before anything is written.
 *
 * The first is 14.3's one new rule: restoring a child whose parent is still
 * trashed **in another batch** is refused, naming the batch to restore first.
 * A parent inside this same batch is fine — it is coming back in the same act.
 * A parent that no longer exists at all is also fine: an absent link does not
 * prove abandonment (case L10), and the restore leaves a record whose parent
 * slot points at nothing rather than refusing a row nobody can ever recover.
 *
 * The second is the one T1d's trigger creates: a trashed record releases its
 * unique claims, so restoring re-takes them, and if somebody took the value
 * meanwhile the re-claim would fail. It is refused by name here instead.
 */
export async function restoreBatch(
  tx: TenantQuery,
  options: { readonly batchId: string },
): Promise<RestoreResult | RecordsRefusal> {
  const rows = await tx.query<BatchRow>(
    `select r.id,
            r.${PARENT} as parent_id,
            (parent.deleted_at is not null) as parent_deleted,
            parent.trash_batch_id as parent_batch
       from records r
       left join records parent
         on parent.business_id = r.business_id and parent.id = r.${PARENT}
      where r.business_id = $1 and r.trash_batch_id = $2`,
    [tx.businessId, options.batchId],
  );
  if (rows.length === 0) {
    return refuse(
      'NOT_FOUND',
      ['trash batch'],
      [
        'No record in this business carries that batch identity.',
        'A batch identity is minted by task.trash and is not a record identifier.',
      ],
    );
  }

  const inThisBatch = new Set(rows.map((row) => row.id));
  const blocked = rows.find(
    (row) =>
      row.parent_id !== null &&
      row.parent_deleted === true &&
      !inThisBatch.has(row.parent_id) &&
      row.parent_batch !== options.batchId,
  );
  if (blocked !== undefined) {
    return refuse(
      'PARENT_TRASHED',
      [blocked.id, blocked.parent_batch ?? ''],
      [
        'This record’s parent is still in the trash, in the batch named here.',
        'Restore that batch first, then this one.',
      ],
    );
  }

  const taken = await claimsAlreadyTaken(tx, [...inThisBatch]);
  if (taken !== undefined) return taken;

  const restored = await tx.query<{ readonly id: string }>(
    `update records
        set deleted_at = null, deleted_by_actor_id = null, trash_batch_id = null
      where business_id = $1 and trash_batch_id = $2
      returning id`,
    [tx.businessId, options.batchId],
  );
  return { batchId: options.batchId, recordIds: restored.map((each) => each.id) };
}

/**
 * Whether restoring these rows would collide with a value a live record holds.
 *
 * The would-be claim is computed the way the trigger computes it — the field's
 * key read out of `data`, trimmed and lower-cased — so this check and the
 * write it protects read the same rule. A claim held by a row that is itself
 * in this batch is not a collision: those rows released their claims when they
 * were trashed and are taking them back together.
 */
async function claimsAlreadyTaken(
  tx: TenantQuery,
  recordIds: readonly string[],
): Promise<RecordsRefusal | undefined> {
  const clashes = await tx.query<{ readonly field_key: string; readonly value: string }>(
    `select f.key as field_key, lower(btrim(r.data ->> f.key)) as value
       from records r
       join field_defs f
         on f.business_id = r.business_id
        and f.record_type_id = r.record_type_id
        and f.unique_value
        and f.deactivated_at is null
       join record_unique_values held
         on held.business_id = r.business_id
        and held.field_def_id = f.id
        and held.canonical_value = lower(btrim(r.data ->> f.key))
      where r.business_id = $1
        and r.id = any ($2::uuid[])
        and jsonb_typeof(r.data -> f.key) = 'string'
        and held.record_id <> all ($2::uuid[])
      limit 1`,
    [tx.businessId, recordIds],
  );
  const clash = clashes[0];
  if (clash === undefined) return undefined;
  return refuse(
    'UNIQUE_VALUE_TAKEN',
    [clash.field_key, clash.value],
    [
      'A live record took this value while the record was in the trash.',
      'Change the value on one of the two, then restore again.',
    ],
  );
}

export interface PurgeResult {
  readonly recordIds: readonly string[];
  /**
   * Trash old enough to purge that the runtime still holds: a proposal named
   * it, so a lineage, planned run, envelope or lease points at it. Kept, and
   * named, rather than faulted on.
   */
  readonly retainedIds: readonly string[];
}

/**
 * Purge trashed records of one record type, permanently.
 *
 * Never a cascade and never a trigger (specification, 14.3): it is an explicit
 * operation, and the caller writes the audit event from what this returns. The
 * window is a parameter rather than a setting, so a test can set it to nothing
 * and watch the operation refuse the evidence class and accept the work class
 * in the same run — which is what the first slice builds instead of a timed
 * sweep nobody can watch run.
 */
export async function purgeTrashedRecords(
  tx: TenantQuery,
  options: { readonly recordTypeId: string; readonly trashedBefore: Date },
): Promise<PurgeResult | RecordsRefusal> {
  const types = await tx.query<{ readonly key: string; readonly retention_class: RetentionClass }>(
    `select key, retention_class from record_types where business_id = $1 and id = $2`,
    [tx.businessId, options.recordTypeId],
  );
  const type = types[0];
  if (type === undefined) {
    return refuse('NOT_FOUND', ['record type'], ['No record type carries that identifier here.']);
  }
  if (type.retention_class !== 'work') {
    return refuse(
      'RETENTION_CLASS_PROTECTED',
      [type.key, type.retention_class],
      [
        `The ${type.key} type is in the ${type.retention_class} class and this operation will not purge it.`,
        'Only the work class is purged, and only from the trash.',
      ],
    );
  }

  // A task a proposal ever named is pointed at by the runtime tables, each
  // through a composite key to `records` that does not cascade (0010's
  // lineages and planned runs, 0013's envelopes and leases). Those rows are the
  // runtime class, refused rather than touched, and deleting the task under
  // them would fault on the key and roll the whole purge back — every time,
  // for every trashed task in the business (0007 names this failure). So the
  // purge keeps such a task, says so, and purges the rest. Restoring the
  // task, or a runtime retention rule this slice does not build, is what
  // would ever release it.
  const aged = await tx.query<{ readonly id: string; readonly held: boolean }>(
    `select r.id,
            (exists (select 1 from public.proposal_lineages l
                      where l.business_id = r.business_id and l.task_id = r.id)
             or exists (select 1 from public.planned_runs p
                         where p.business_id = r.business_id and p.task_id = r.id)
             or exists (select 1 from public.task_envelopes e
                         where e.business_id = r.business_id and e.task_id = r.id)
             or exists (select 1 from public.leases s
                         where s.business_id = r.business_id and s.task_id = r.id)) as held
       from records r
      where r.business_id = $1 and r.record_type_id = $2
        and r.deleted_at is not null and r.deleted_at < $3
      order by r.id`,
    [tx.businessId, options.recordTypeId, options.trashedBefore],
  );
  const retainedIds = aged.filter((each) => each.held).map((each) => each.id);
  const ids = aged.filter((each) => !each.held).map((each) => each.id);
  if (ids.length === 0) return { recordIds: [], retainedIds };

  // Links first: both ends carry a composite foreign key to `records`, so a
  // link outliving its record is refused by the server rather than dangling.
  await tx.query(
    `delete from record_links
      where business_id = $1 and (from_record_id = any ($2::uuid[]) or to_record_id = any ($2::uuid[]))`,
    [tx.businessId, ids],
  );
  await tx.query(`delete from records where business_id = $1 and id = any ($2::uuid[])`, [
    tx.businessId,
    ids,
  ]);
  return { recordIds: ids, retainedIds };
}
