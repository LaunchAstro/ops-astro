// SPDX-License-Identifier: AGPL-3.0-only
//
// Retention's owed asks (#475), read by both sides of the trace store. An ask
// (`trace_expiry_asks`) is owed until a batch confirms its run at the ask's
// place or later, and for as long as its run has an event after that place
// inside the window: a confirmation proves one delete landed, never that no
// other is still queued, and a queued delete takes whatever the trace holds
// when it lands. Retention reads the owed asks back each pass, by every span
// the export has sent of the run since its place: a body sent before the
// delete may still be stored after it, and restores only its own spans. An
// ask unconfirmed past the window, its run with no later event, is settled
// once and owed no more. Here too are what a turn finds due, and the history
// that confirms a run.

import type { TenantQuery } from '../../core-records/src/index.ts';
import type { RetentionBatch } from './trace-retention.ts';
import type { Turn } from './trace-store.ts';

/** The owed asks, one per run at its latest place: `$1` the business, `$2` its runs or null for all. */
const owedOf = (cutoff: string): string => `select o.run_id, o.after_tx, o.after_id from (
       select distinct on (a.run_id) a.run_id, a.after_tx, a.after_id
         from public.trace_expiry_asks a
        where a.business_id = $1 and ($2::uuid[] is null or a.run_id = any($2::uuid[]))
        order by a.run_id, a.after_tx desc, a.after_id desc) o
      where (not exists (select 1 from public.trace_expiry_batches b
                          where b.business_id = $1 and b.expired_run_ids @> array[o.run_id]
                            and (b.after_tx, b.after_id) >= (o.after_tx, o.after_id))
             or exists (select 1 from public.run_events ev
                         where ev.business_id = $1 and ev.run_id = o.run_id
                           and (ev.tx, ev.id) > (o.after_tx, o.after_id)
                           and ev.created_at >= ${cutoff}))
        and not exists (select 1 from public.trace_expiry_batches b
                         where b.business_id = $1 and b.code = 'unconfirmed_expired'
                           and b.unread_run_ids @> array[o.run_id]
                           and (b.after_tx, b.after_id) >= (o.after_tx, o.after_id))`;

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
 * reach, so no run's reads hide another's. Every page of a turn judges the
 * window from the turn's one `cutoff`.
 */
export async function owedAsks(
  tx: TenantQuery,
  cutoff: string,
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
                  and ev.created_at >= $3::timestamptz) as sent,
              coalesce(r.recorded_at, '-infinity') as turn,
              coalesce(r.answered, false) as answered, r.resume
         from (${owedOf('$3::timestamptz')}) o
         left join lateral (
           select b.recorded_at, b.read_run_ids @> array[o.run_id] as answered,
                  b.resume_ids[array_position(b.unanswered_run_ids, o.run_id)]::text as resume
             from public.trace_expiry_batches b
            where b.business_id = $1 and b.recorded_at >= $3::timestamptz
              and (b.unanswered_run_ids @> array[o.run_id] or b.read_run_ids @> array[o.run_id])
            order by b.recorded_at desc limit 1) r on true) owed
      where $4::text is null
         or (turn, answered, run_id) > ($4::text::timestamptz, $5::boolean, $6::uuid)
      order by owed.turn, owed.answered, owed.run_id limit $7`,
    [
      tx.businessId,
      null,
      cutoff,
      after?.turn ?? null,
      after?.answered ?? null,
      after?.runId ?? null,
      page,
    ],
  );
}

/** Owed asks grouped by place: one read back and batch per place. */
export function byPlace(owed: readonly Owed[]): readonly Ask[] {
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
    `with owed as (${owedOf('now() - make_interval(days => $3)')})
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

/** Runs asked at one place: every event of them up to it was behind the export's cursor. */
export interface Ask {
  readonly runs: readonly string[];
  readonly place: Place;
}

/**
 * The due runs after `$3`, up to `$4`: a registered trace copy, every event
 * behind the export's cursor, the newest older than the cutoff `$2`, an event
 * after the place of its last confirmation if it has one, and no delete
 * awaiting its reads: a run whose ask covers every event of it, its latest
 * result since absent or unread, is owed, not due. Read present, or not read
 * since a failed delete, it is asked again.
 */
const DUE = `with last as (
       select run_id, max(created_at) as last_at from public.run_events
        where business_id = $1 group by run_id
     ), confirmed as (
       select distinct on (run_id) run_id, b.after_tx, b.after_id
         from public.trace_expiry_batches b, unnest(b.expired_run_ids) as run_id
        where b.business_id = $1 and b.after_tx is not null
        order by run_id, b.after_tx desc, b.after_id desc
     )
     select l.run_id, cur.after_tx::text as tx, cur.after_id as id from last l
       join public.copy_registrations c
         on c.business_id = $1 and c.copy_class = 'diagnostic_trace'
        and c.copy_key = 'run:' || l.run_id::text
       join public.trace_export_cursors cur on cur.business_id = $1 and cur.after_tx is not null
       left join confirmed e on e.run_id = l.run_id
      where l.last_at < $2::timestamptz and ($3::uuid is null or l.run_id > $3::uuid)
        and (e.run_id is null
             or exists (select 1 from public.run_events p
                         where p.business_id = $1 and p.run_id = l.run_id
                           and (p.tx, p.id) > (e.after_tx, e.after_id)))
        and not exists (select 1 from public.run_events p
                         where p.business_id = $1 and p.run_id = l.run_id
                           and (p.tx, p.id) > (cur.after_tx, cur.after_id))
        and not exists (
              select 1 from public.trace_expiry_asks a
               where a.business_id = $1 and a.run_id = l.run_id
                 and not exists (select 1 from public.run_events p
                                  where p.business_id = $1 and p.run_id = l.run_id
                                    and (p.tx, p.id) > (a.after_tx, a.after_id))
                 and (select not b.present_run_ids @> array[l.run_id]
                        from public.trace_expiry_batches b
                       where b.business_id = $1 and b.recorded_at >= a.asked_at
                         and (b.absent_run_ids @> array[l.run_id] or b.present_run_ids @> array[l.run_id]
                              or b.unread_run_ids @> array[l.run_id])
                       order by b.pass_seq desc, b.recorded_at desc limit 1))
      order by l.run_id
      limit $4`;

/** Up to `limit` due runs after `after`, and an ask for each written before anything is deleted. */
export async function askDue(
  tx: TenantQuery,
  cutoff: string,
  after: string | null,
  limit: number,
): Promise<Ask> {
  const rows = await tx.query<{ readonly run_id: string } & Place>(DUE, [
    tx.businessId,
    cutoff,
    after,
    limit,
  ]);
  const runs = rows.map((row) => row.run_id);
  const place = { tx: rows[0]?.tx ?? null, id: rows[0]?.id ?? null };
  if (runs.length > 0) {
    await tx.query(
      `insert into public.trace_expiry_asks (business_id, id, run_id, after_tx, after_id)
       select $1, gen_random_uuid(), run_id, $3::xid8, $4::uuid from unnest($2::uuid[]) as run_id`,
      [tx.businessId, runs, place.tx, place.id],
    );
  }
  return { runs, place };
}

/**
 * A turn's start: its number from the cursor row and its cutoff, read once.
 * Then each owed run with an ask older than the cutoff that no batch confirmed
 * and no event of the run came after is settled once: a row per place,
 * `unconfirmed_expired`, naming the runs as unread, the operations alert
 * naming the business and each run. Nothing without a cursor row.
 */
export async function beginTurn(
  tx: TenantQuery,
  passId: string,
  windowDays: number,
): Promise<{ readonly turn: Turn; readonly settled: readonly RetentionBatch[] } | undefined> {
  const [row] = await tx.query<{ readonly seq: string; readonly cutoff: string }>(
    `update public.trace_export_cursors set pass_seq = pass_seq + 1 where business_id = $1
     returning pass_seq::text as seq, to_char((clock_timestamp() - make_interval(days => $2))
       at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cutoff`,
    [tx.businessId, windowDays],
  );
  if (row === undefined) return undefined;
  const turn = { passId, seq: row.seq, cutoff: row.cutoff, windowDays };
  const settled = await tx.query<RetentionBatch>(
    `insert into public.trace_expiry_batches (business_id, id, window_days, runs, expired_run_ids,
       code, unread_run_ids, after_tx, after_id, pass_id, pass_seq)
     select $1, gen_random_uuid(), $4, count(*), '{}', 'unconfirmed_expired',
            array_agg(o.run_id), o.after_tx, o.after_id, $5, $6::bigint
       from (${owedOf('$3::timestamptz')}) o
      where exists (select 1 from public.trace_expiry_asks f
                     where f.business_id = $1 and f.run_id = o.run_id and f.asked_at < $3::timestamptz
                       and not exists (select 1 from public.run_events p
                                        where p.business_id = $1 and p.run_id = f.run_id
                                          and (p.tx, p.id) > (f.after_tx, f.after_id))
                       and not exists (select 1 from public.trace_expiry_batches b
                                        where b.business_id = $1 and b.expired_run_ids @> array[f.run_id]
                                          and (b.after_tx, b.after_id) >= (f.after_tx, f.after_id)))
      group by o.after_tx, o.after_id
     returning runs, 0 as confirmed, code`,
    [tx.businessId, null, turn.cutoff, windowDays, passId, turn.seq],
  );
  return { turn, settled };
}

/**
 * Of `runs`, those whose two latest results are both absent, from different
 * passes, in turns one after the other: nothing read between them, and no
 * turn that did not read them. Read under the cursor row lock, after this
 * read's results are recorded.
 */
export async function absentHistory(
  tx: TenantQuery,
  runs: readonly string[],
): Promise<ReadonlySet<string>> {
  if (runs.length === 0) return new Set();
  const rows = await tx.query<{ readonly runId: string }>(
    `select r.run_id as "runId" from unnest($2::uuid[]) as r(run_id)
      where (select count(*) = 2 and bool_and(h.absent) and count(distinct h.pass_id) = 2
                    and max(h.pass_seq) = min(h.pass_seq) + 1
               from (select b.absent_run_ids @> array[r.run_id] as absent, b.pass_id, b.pass_seq
                       from public.trace_expiry_batches b
                      where b.business_id = $1
                        and (b.absent_run_ids @> array[r.run_id]
                             or b.present_run_ids @> array[r.run_id]
                             or b.unread_run_ids @> array[r.run_id])
                      order by b.pass_seq desc, b.recorded_at desc limit 2) h)`,
    [tx.businessId, runs],
  );
  return new Set(rows.map((row) => row.runId));
}
