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

import { readableTaskCondition, readableTaskParams } from '../../../core-records/src/index.ts';
import type { Subject, TenantQuery } from '../../../core-records/src/index.ts';
import type { RankView } from '../../../core-wire/src/index.ts';
import { calcLine, numberPool, scoreTask, rankInputOf, type RankPoolRow } from './rank.ts';

/**
 * Each task's rank in the pool `readers` reach, judged inside the query
 * (`readableTaskCondition`), as `readTaskRank` judges its pool; null reads
 * every task. The clock is the database's, as `readTaskRank`'s is.
 */
export async function readRanks(
  tx: TenantQuery,
  taskTypeId: string,
  readers: readonly Subject[] | null,
): Promise<ReadonlyMap<string, RankView>> {
  const rows = await tx.query<RankPoolRow>(
    `select r.id, r.txt_1 as key, r.num_2::text as position,
            r.num_3::text as impact, r.num_4::text as confidence, r.num_5::text as ease, r.txt_5 as stage,
            priority.value as priority_stages,
            coalesce(s.data ->> 'machine_category', '') not in ('completed', 'cancelled')
              and not (r.data ? 'archived_at') as open,
            (r.data ->> 'started_at')::timestamptz as started_at, now() as now
       from public.records r
       left join public.records s
         on s.business_id = r.business_id and s.id = r.uuid_1 and s.deleted_at is null
       left join public.business_settings priority
         on priority.business_id = r.business_id and priority.key = 'priority_stages'
        and priority.value_type = 'stage_ids'
      where r.business_id = $1 and r.record_type_id = $2 and r.deleted_at is null
        and ($3::text[] is null or ${readableTaskCondition('r', 3)})`,
    [tx.businessId, taskTypeId, ...readableTaskParams(readers)],
  );
  const now = rows[0]?.now ?? new Date();
  const numbers = numberPool(
    rows.filter((row) => row.open).map((row) => rankInputOf(row)),
    now,
  );
  return new Map(
    rows.map((row): [string, RankView] => {
      const scored = scoreTask(rankInputOf(row), now);
      return [
        row.id,
        { number: numbers.get(row.id) ?? null, score: scored.score, calc: calcLine(scored) },
      ];
    }),
  );
}
