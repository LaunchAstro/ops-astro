// SPDX-License-Identifier: AGPL-3.0-only
//
// Every board row's rank in one reader's pool (MP-5-8, R70): the Projects
// board draws many ranks, so it reads the pool once rather than once per row.
//
// The derivation is `rank.ts`'s (MP-4-9): the same score, the same #N order,
// the same calc line. What this file owns is the pool read, which has to be
// the pool `readTaskRank` reads for the same reader, or a task's #N on the
// board would differ from the #N on its page: the live tasks the reader's
// read grants reach, open unless completed, cancelled or archived by a
// parent's completion (MP-4-15). `mp-5-8-board-columns` and
// `mp-5-8-board-rank-steps` read every row back against `task.read`.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { RankView } from '../../../core-wire/src/index.ts';
import { calcLine, numberPool, scoreTask, type RankInput } from './rank.ts';

interface PoolRow {
  readonly id: string;
  readonly key: string | null;
  readonly position: string | null;
  readonly impact: string | null;
  readonly confidence: string | null;
  readonly ease: string | null;
  readonly open: boolean;
  readonly now: Date;
}

const markOf = (value: string | null): number | null => (value === null ? null : Number(value));

// As `rank.ts` reads a task: no business names priority stages yet and a
// task carries no start date, so every weight and age boost is 1.
function inputOf(row: PoolRow): RankInput {
  return {
    id: row.id,
    key: row.key ?? '',
    position: row.position === null ? null : Number(row.position),
    marks: {
      impact: markOf(row.impact),
      confidence: markOf(row.confidence),
      ease: markOf(row.ease),
    },
    priorityStage: false,
    open: row.open,
    startedAt: null,
  };
}

/**
 * Each task's rank in the pool `readable` names. `readable` is the caller's
 * scope from the one grant read that admitted the board (null under a
 * collection-wide grant), so the pool is filtered inside the query and no
 * second read of the grants can disagree with the first. The clock is the
 * database's, as `readTaskRank`'s is.
 */
export async function readRanks(
  tx: TenantQuery,
  taskTypeId: string,
  readable: readonly string[] | null,
): Promise<ReadonlyMap<string, RankView>> {
  const rows = await tx.query<PoolRow>(
    `select r.id, r.txt_1 as key, r.num_2::text as position,
            r.num_3::text as impact, r.num_4::text as confidence, r.num_5::text as ease,
            coalesce(s.data ->> 'machine_category', '') not in ('completed', 'cancelled')
              and not (r.data ? 'archived_at') as open,
            now() as now
       from public.records r
       left join public.records s
         on s.business_id = r.business_id and s.id = r.uuid_1 and s.deleted_at is null
      where r.business_id = $1 and r.record_type_id = $2 and r.deleted_at is null
        and ($3::uuid[] is null or r.id = any($3::uuid[]))`,
    [tx.businessId, taskTypeId, readable],
  );
  const now = rows[0]?.now ?? new Date();
  const numbers = numberPool(
    rows.filter((row) => row.open).map((row) => inputOf(row)),
    now,
  );
  return new Map(
    rows.map((row): [string, RankView] => {
      const scored = scoreTask(inputOf(row), now);
      return [
        row.id,
        { number: numbers.get(row.id) ?? null, score: scored.score, calc: calcLine(scored) },
      ];
    }),
  );
}
