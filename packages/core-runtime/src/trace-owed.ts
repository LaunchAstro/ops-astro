// SPDX-License-Identifier: AGPL-3.0-only
//
// Retention's owed asks (#475), read by both sides of the trace store. An ask
// (`trace_expiry_asks`) is owed until a batch confirms its run at the ask's
// place or later, and for as long as its run has an event after that place
// inside the window: a confirmation proves one delete landed, never that no
// other is still queued, and a queued delete takes whatever the trace holds
// when it lands. Retention reads the owed asks back each pass, by every span
// the export has sent of the run since its place: a body sent before the
// delete may still be stored after it, and restores only its own spans.

import type { TenantQuery } from '../../core-records/src/index.ts';

/**
 * The owed asks, one per run at its latest place: `$1` the business, `$2` the
 * runs it is limited to, or null for every run, `$3` the window in days.
 */
const OWED_ASKS = `select o.run_id, o.after_tx, o.after_id from (
       select distinct on (a.run_id) a.run_id, a.after_tx, a.after_id
         from public.trace_expiry_asks a
        where a.business_id = $1 and ($2::uuid[] is null or a.run_id = any($2::uuid[]))
        order by a.run_id, a.after_tx desc, a.after_id desc) o
      where not exists (select 1 from public.trace_expiry_batches b
                         where b.business_id = $1 and b.expired_run_ids @> array[o.run_id]
                           and (b.after_tx, b.after_id) >= (o.after_tx, o.after_id))
         or exists (select 1 from public.run_events ev
                     where ev.business_id = $1 and ev.run_id = o.run_id
                       and (ev.tx, ev.id) > (o.after_tx, o.after_id)
                       and ev.created_at >= now() - make_interval(days => $3))`;

/** An export cursor's place, as an ask read it. */
interface Place {
  readonly tx: string | null;
  readonly id: string | null;
}

/**
 * One owed ask: its run, its place, the run's events after the place that the
 * export has sent and the window still holds, newest first (null for none),
 * and its turn: when a pass last read it, as ISO 8601 text in UTC to the
 * microsecond whatever the session's settings, or `-infinity` when none did;
 * whether that pass had its answer, and if not, the span its read stopped at.
 */
export type Owed = {
  readonly runId: string;
  readonly sent: readonly string[] | null;
  readonly turn: string;
  readonly answered: boolean;
  readonly resume: string | null;
} & Place;

/** Where a page of the owed asks starts: after this turn and run. */
export type OwedFrom = Pick<Owed, 'turn' | 'answered' | 'runId'>;

/**
 * One page of the owed asks, one per run at its latest place, after `after`
 * in turn order: the runs read longest ago first, and of one pass's, those it
 * left unanswered first. A few traces that never answer wait behind every run
 * read since, and runs that always answer wait behind the ones a pass did not
 * reach, so no run's reads hide another's.
 */
export async function owedAsks(
  tx: TenantQuery,
  windowDays: number,
  after: OwedFrom | null,
  page: number,
): Promise<readonly Owed[]> {
  return await tx.query<Owed>(
    `select run_id as "runId", after_tx::text as tx, after_id as id, sent, answered, resume,
            case when isfinite(turn)
                 then to_char(turn at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 else turn::text end as turn
       from (
       select o.*,
              (select array_agg(ev.id::text order by ev.tx desc, ev.id desc)
                 from public.run_events ev
                 join public.trace_export_cursors cur on cur.business_id = $1
                where ev.business_id = $1 and ev.run_id = o.run_id
                  and (ev.tx, ev.id) > (o.after_tx, o.after_id)
                  and (ev.tx, ev.id) <= (cur.after_tx, cur.after_id)
                  and ev.created_at >= now() - make_interval(days => $3)) as sent,
              coalesce(r.recorded_at, '-infinity') as turn,
              coalesce(r.answered, false) as answered, r.resume
         from (${OWED_ASKS}) o
         left join lateral (
           select b.recorded_at, b.read_run_ids @> array[o.run_id] as answered,
                  b.resume_ids[array_position(b.unanswered_run_ids, o.run_id)]::text as resume
             from public.trace_expiry_batches b
            where b.business_id = $1 and b.recorded_at >= now() - make_interval(days => $3)
              and (b.unanswered_run_ids @> array[o.run_id] or b.read_run_ids @> array[o.run_id])
            order by b.recorded_at desc limit 1) r on true) owed
      where $4::text is null
         or (turn, answered, run_id) > ($4::text::timestamptz, $5::boolean, $6::uuid)
      order by owed.turn, owed.answered, owed.run_id limit $7`,
    [
      tx.businessId,
      null,
      windowDays,
      after?.turn ?? null,
      after?.answered ?? null,
      after?.runId ?? null,
      page,
    ],
  );
}

/** Owed asks grouped by place: one read back and batch per place. */
export function byPlace(
  owed: readonly Owed[],
): readonly { readonly runs: readonly string[]; readonly place: Place }[] {
  const asks = new Map<string, { runs: string[]; place: Place }>();
  for (const row of owed) {
    const at = `${String(row.tx)}/${String(row.id)}`;
    const ask = asks.get(at) ?? { runs: [], place: { tx: row.tx, id: row.id } };
    ask.runs.push(row.runId);
    asks.set(at, ask);
  }
  return [...asks.values()];
}

/**
 * A run with an owed ask goes whole: with any event of it in an export's
 * `batch`, its events since the ask's place that are behind `from` and inside
 * the window go again, every one in the same body (`cells` are the export's
 * span columns over `ev`). A delete that lands between two exports leaves a
 * trace of the later events only, which reads back present; sent whole, it
 * holds every one.
 */
export async function owedSince<T>(
  tx: TenantQuery,
  cells: string,
  batch: readonly { readonly runId: string; readonly past: boolean }[],
  from: Place,
  windowDays: number,
): Promise<readonly T[]> {
  const runs = [...new Set(batch.filter((row) => !row.past).map((row) => row.runId))];
  if (runs.length === 0 || from.tx === null) return [];
  return await tx.query<T>(
    `with owed as (${OWED_ASKS})
     select ${cells}
       from public.run_events ev
       join owed o on o.run_id = ev.run_id
      where ev.business_id = $1
        and (ev.tx, ev.id) > (o.after_tx, o.after_id)
        and (ev.tx, ev.id) <= ($4::xid8, $5::uuid)
        and ev.created_at >= now() - make_interval(days => $3)
      order by ev.tx, ev.id`,
    [tx.businessId, runs, windowDays, from.tx, from.id],
  );
}
