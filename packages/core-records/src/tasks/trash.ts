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
import { COMMENT_SPINE } from './comments.ts';

const PARENT = slotOf(TASK_SPINE, 'parent');
const BOARD = slotOf(TASK_SPINE, 'board');
const COMMENT_TASK = slotOf(COMMENT_SPINE, 'task');

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
 * The walk's rows are locked `for update`, and the walk is read again until
 * it finds nothing it has not locked. The envelope locks only the root, and a
 * create or restore under a descendant holds that descendant `for share`
 * while its child is not yet visible, so a walk read once could miss the
 * child and stamp the parent after it commits: a live child under a trashed
 * parent, outside the batch (R1-THERMO-16, R2-RUNTIME-15). Locking waits for
 * that transaction, and the next walk sees what it committed.
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

  const walk = async (): Promise<readonly string[]> =>
    (
      await tx.query<{ readonly id: string }>(
        // `cycle` is not decoration. `parent` is an ordinary uuid slot with no
        // foreign key to itself, so nothing in the schema stops `task.reparent`
        // from producing a loop, and a recursive query over a loop does not
        // return — it runs until the server runs out of something. The clause
        // stops the walk at a record it has already seen. The record-type
        // filter is the same argument: the walk should follow tasks, not
        // whatever else happens to carry a value in that column.
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
      )
    ).map((each) => each.id);
  const locked = new Set<string>();
  let ids = await walk();
  while (ids.some((id) => !locked.has(id))) {
    // In id order, which orders only this loop's own locks. The envelope has
    // already locked the root, and a move or reparent its target, outside that
    // order, so a nested trash, a move, a reparent or a restore can still
    // deadlock with this walk. The server rolls the victim back whole and the
    // envelope retries it once (register-store.ts, 40P01), and the retry
    // answers from what the winner committed: a nested trash applies without
    // the winner's batch (final-r3-place.test.ts, R4-RUNTIME-7). Taking the
    // root in this order would not help, since the envelope holds it before
    // the walk runs.
    // eslint-disable-next-line no-await-in-loop
    await tx.query(
      `select id from records where business_id = $1 and id = any ($2::uuid[])
        order by id for update`,
      [tx.businessId, ids],
    );
    for (const id of ids) locked.add(id);
    // eslint-disable-next-line no-await-in-loop
    ids = await walk();
  }
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
}

interface ParentRow {
  readonly id: string;
  readonly deleted: boolean;
  readonly trash_batch_id: string | null;
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
 * The parents outside the batch are read `for share`, in a statement of their
 * own because a lock cannot sit on the nullable side of a left join. Without
 * it a trash of the parent committing between this check and the write below
 * leaves the restored child live under a trashed parent and outside the
 * parent's batch (R2-RUNTIME-15). With it, a trash that got there first makes
 * this read wait and then see the parent trashed, and a trash that comes
 * second waits for this restore and its walk takes the restored child in:
 * the same pair of orders `readParent` gives create and reparent.
 *
 * The second is the one T1d's trigger creates: a trashed record releases its
 * unique claims, so restoring re-takes them, and if somebody took the value
 * meanwhile the re-claim would fail. It is refused by name here instead.
 *
 * A subtask's board is its parent's (specification 14.2 point 2), and a move
 * or reparent carries the board to the live subtree only, so a row trashed
 * before its root moved still holds the old board. The write therefore takes
 * the board again from the live parent outside the batch, for that row and
 * the batch rows below it (R3-RUNTIME-11). That parent is the row read `for
 * share` above, so a move holding it waits for this restore, whose rows its
 * rewrite then sees live, or this restore waits for the move and reads the
 * board it wrote. A top-level row keeps its own board, and a row whose parent
 * no longer exists (case L10) keeps the board it had.
 */
export async function restoreBatch(
  tx: TenantQuery,
  options: { readonly batchId: string },
): Promise<RestoreResult | RecordsRefusal> {
  const rows = await tx.query<BatchRow>(
    `select id, ${PARENT} as parent_id from records
      where business_id = $1 and trash_batch_id = $2`,
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
  const outside = [
    ...new Set(
      rows.flatMap((row) =>
        row.parent_id !== null && !inThisBatch.has(row.parent_id) ? [row.parent_id] : [],
      ),
    ),
  ];
  const parents =
    outside.length === 0
      ? []
      : await tx.query<ParentRow>(
          `select id, (deleted_at is not null) as deleted, trash_batch_id from records
            where business_id = $1 and id = any ($2::uuid[])
            order by id
            for share`,
          [tx.businessId, outside],
        );
  const trashedParent = new Map(
    parents
      .filter((parent) => parent.deleted && parent.trash_batch_id !== options.batchId)
      .map((parent) => [parent.id, parent.trash_batch_id]),
  );
  const blocked = rows.find((row) => row.parent_id !== null && trashedParent.has(row.parent_id));
  if (blocked !== undefined) {
    return refuse(
      'PARENT_TRASHED',
      [blocked.id, trashedParent.get(blocked.parent_id ?? '') ?? ''],
      [
        'This record’s parent is still in the trash, in the batch named here.',
        'Restore that batch first, then this one.',
      ],
    );
  }

  const taken = await claimsAlreadyTaken(tx, [...inThisBatch]);
  if (taken !== undefined) return taken;

  const restored = await tx.query<{ readonly id: string }>(
    `with recursive carried (id, board) as (
         select r.id, p.${BOARD}::text from records r
           join records p on p.business_id = r.business_id and p.id = r.${PARENT}
          where r.business_id = $1 and r.trash_batch_id = $2 and p.deleted_at is null
         union all
         select child.id, carried.board from records child
           join carried on child.${PARENT} = carried.id
          where child.business_id = $1 and child.trash_batch_id = $2
       ) cycle id set looped using path,
       placed as (
         select b.id, carried.id is not null as derived, carried.board from records b
           left join carried on carried.id = b.id and not carried.looped
          where b.business_id = $1 and b.trash_batch_id = $2
       )
     update records r
        set deleted_at = null, deleted_by_actor_id = null, trash_batch_id = null,
            data = case when not placed.derived then r.data
                        when placed.board is null then r.data - 'board'
                        else jsonb_set(r.data, '{board}', to_jsonb(placed.board)) end
       from placed
      where r.business_id = $1 and r.id = placed.id and r.trash_batch_id = $2
      returning r.id`,
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
  /** The comments of the purged records, removed with them. */
  readonly commentIds: readonly string[];
  /** How many grants scoped to a purged record or comment were revoked. */
  readonly grantsRevoked: number;
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
  options: {
    readonly recordTypeId: string;
    readonly trashedBefore: Date;
    /** The comment type whose records hang off these, when the business has one. */
    readonly commentTypeId?: string | undefined;
  },
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

  // The candidates are locked, so a restore either commits first and the row
  // drops out here (read committed re-checks the predicate on the new row), or
  // waits for the purge. Without the lock a restore committing between this
  // read and the delete turned the purge into a key fault (R2-RUNTIME-53).
  const aged = await tx.query<{ readonly id: string }>(
    `select id from records
      where business_id = $1 and record_type_id = $2
        and deleted_at is not null and deleted_at < $3
      order by id
      for update`,
    [tx.businessId, options.recordTypeId, options.trashedBefore],
  );
  if (aged.length === 0)
    return { recordIds: [], retainedIds: [], commentIds: [], grantsRevoked: 0 };

  // A task a proposal ever named is pointed at by the runtime tables, each
  // through a composite key to `records` that does not cascade (0010's
  // lineages and planned runs, 0013's envelopes and leases). Those rows are the
  // runtime class, refused rather than touched, and deleting the task under
  // them would fault on the key and roll the whole purge back — every time,
  // for every trashed task in the business (0007 names this failure). So the
  // purge keeps such a task, says so, and purges the rest. Restoring the
  // task, or a runtime retention rule this slice does not build, is what
  // would ever release it. Asked after the lock, in a statement of its own,
  // so a row that took a key share on the task before the lock is seen, and
  // none can take one after it.
  const holding = await tx.query<{ readonly id: string; readonly held: boolean }>(
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
      where r.business_id = $1 and r.id = any ($2::uuid[])
      order by r.id`,
    [tx.businessId, aged.map((each) => each.id)],
  );
  const retainedIds = holding.filter((each) => each.held).map((each) => each.id);
  const ids = holding.filter((each) => !each.held).map((each) => each.id);
  if (ids.length === 0) return { recordIds: [], retainedIds, commentIds: [], grantsRevoked: 0 };

  // A purged task's comments are in the work class with it (14.3: "records
  // and their bodies, comments, views"), and nothing reaches them once the
  // task is gone, so they go in the same act, explicitly (R2-RUNTIME-16).
  const commentIds =
    options.commentTypeId === undefined
      ? []
      : (
          await tx.query<{ readonly id: string }>(
            `select id from records
              where business_id = $1 and record_type_id = $2 and ${COMMENT_TASK} = any ($3::uuid[])
              order by id
              for update`,
            [tx.businessId, options.commentTypeId, ids],
          )
        ).map((each) => each.id);
  const gone = [...ids, ...commentIds];

  // Links first: both ends carry a composite foreign key to `records`, so a
  // link outliving its record is refused by the server rather than dangling.
  await tx.query(
    `delete from record_links
      where business_id = $1 and (from_record_id = any ($2::uuid[]) or to_record_id = any ($2::uuid[]))`,
    [tx.businessId, gone],
  );
  // A grant's scope carries no foreign key, and 0003 leaves revocation on a
  // deleted record to the operation that deletes it. A grant naming a record
  // that no longer exists would keep its holder's standing (R2-AUTHORITY-60).
  const revoked = await tx.query<{ readonly id: string }>(
    `update public.grants set revoked_at = now()
      where business_id = $1 and scope_kind = 'record' and scope_id = any ($2::uuid[])
        and revoked_at is null
      returning id`,
    [tx.businessId, gone],
  );
  if (commentIds.length > 0) {
    await tx.query(`delete from records where business_id = $1 and id = any ($2::uuid[])`, [
      tx.businessId,
      commentIds,
    ]);
  }
  // The trash predicate again, so the delete's own statement says what it may
  // remove rather than leaning on the lock above.
  const purged = await tx.query<{ readonly id: string }>(
    `delete from records
      where business_id = $1 and id = any ($2::uuid[])
        and deleted_at is not null and deleted_at < $3
      returning id`,
    [tx.businessId, ids, options.trashedBefore],
  );
  return {
    recordIds: purged.map((each) => each.id).toSorted(),
    retainedIds,
    commentIds,
    grantsRevoked: revoked.length,
  };
}
