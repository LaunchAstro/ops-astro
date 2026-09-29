// SPDX-License-Identifier: AGPL-3.0-only
//
// The derived task rank (R70, MP-4-9): one derivation, read and never stored.
//
// A task's score is impact × confidence × ease × priority weight × age boost,
// rounded half up. The three marks are whole numbers from 1 to 10 or absent,
// and absent is never 0: a task missing any of them has no score and is "not
// ranked". The priority weight is 1.25 on one of the business's priority
// stages and 1 otherwise; an open task with a start date gains 5 percent per
// whole week since it started, capped at 1.5.
//
// **Exact arithmetic.** Both modifiers are fractions with small denominators
// (5/4, and (20 + weeks)/20), so the score is one integer fraction and the
// rounding is integer division. 10.5 is never read as 10.4999, which is the
// half-up fixture's whole point.
//
// **The pool is the reader's.** A task's #N is its place among the open tasks
// the reader may read, scored first by score descending, then by the hand-set
// board position, then by key; unscored tasks take no number. A task the
// reader cannot see is not in the pool, so it never moves a number the reader
// is shown. The calc line is built from the task's own marks only, so it names
// no other task. A step archived by its parent's completion (MP-4-15) is not
// open work, so it takes no number until the parent is reopened.

import { readableRecordIds, type Subject } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { RankView } from '../../../core-wire/src/index.ts';

export type MarkName = 'impact' | 'confidence' | 'ease';

const MARKS: readonly MarkName[] = ['impact', 'confidence', 'ease'];

export interface RankInput {
  readonly id: string;
  readonly key: string;
  /** The hand-set board order ("position", R70), `board_rank`. */
  readonly position: number | null;
  readonly marks: { readonly [Name in MarkName]: number | null };
  /** Whether the task's journey stage is one of the business's priority stages. */
  readonly priorityStage: boolean;
  readonly open: boolean;
  readonly startedAt: Date | null;
}

export interface Scored {
  readonly score: number | null;
  readonly missing: readonly MarkName[];
  readonly marks: RankInput['marks'];
  /** As printed on the calc line: `1` or `1.25`. */
  readonly priorityWeight: string;
  /** As printed on the calc line: `1`, `1.05`, up to `1.5`. */
  readonly ageBoost: string;
  readonly weeks: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** 1 + 0.05 × 10 = 1.5, the cap. */
const MOST_WEEKS = 10;

/** Whole weeks since an open task started, capped; a done or unstarted task has none. */
function wholeWeeks(input: RankInput, now: Date): number {
  if (!input.open || input.startedAt === null) return 0;
  const weeks = Math.floor((now.getTime() - input.startedAt.getTime()) / WEEK_MS);
  return Math.min(MOST_WEEKS, Math.max(0, weeks));
}

/** A positive fraction rounded half up to a whole number, in integers. */
function roundHalfUp(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

export function scoreTask(input: RankInput, now: Date): Scored {
  const weeks = wholeWeeks(input, now);
  const shape = {
    missing: MARKS.filter((name) => input.marks[name] === null),
    marks: input.marks,
    priorityWeight: input.priorityStage ? '1.25' : '1',
    // Hundredths, so 1.05 prints as 1.05 and 1.10 as 1.1.
    ageBoost: String((100 + 5 * weeks) / 100),
    weeks,
  };
  const { impact, confidence, ease } = input.marks;
  if (impact === null || confidence === null || ease === null) return { ...shape, score: null };
  // Priority 5/4 or 1/1; age (20 + weeks)/20.
  const [weightTop, weightBottom] = input.priorityStage ? [5, 4] : [1, 1];
  const numerator = impact * confidence * ease * weightTop * (20 + weeks);
  return { ...shape, score: roundHalfUp(numerator, weightBottom * 20) };
}

function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

/**
 * The line under the rank. It says where the marks come from: the task's own
 * ("derived"), or, once a task can be linked to the SWOT entry it came from
 * (MP-8-2), that entry ("inherited from").
 */
export function calcLine(scored: Scored, source?: { readonly inheritedFrom: string }): string {
  if (scored.score === null) return `not ranked: missing ${listed(scored.missing)}`;
  const { impact, confidence, ease } = scored.marks;
  const age =
    scored.weeks === 0
      ? `age ${scored.ageBoost}`
      : `age ${scored.ageBoost} (${scored.weeks} ${scored.weeks === 1 ? 'week' : 'weeks'})`;
  const from = source === undefined ? 'derived' : `inherited from ${source.inheritedFrom}`;
  return (
    `impact ${String(impact)} × confidence ${String(confidence)} × ease ${String(ease)}` +
    ` × priority ${scored.priorityWeight} × ${age} = ${String(scored.score)} · ${from}`
  );
}

const byKey = new Intl.Collator('en', { numeric: true });

/** Each task's #N in this pool, or null for a task that is not ranked. */
export function numberPool(
  inputs: readonly RankInput[],
  now: Date,
): ReadonlyMap<string, number | null> {
  const scored = inputs.map((input) => ({ input, score: scoreTask(input, now).score }));
  const ranked = scored
    .filter((each) => each.score !== null)
    .toSorted(
      (a, b) =>
        (b.score ?? 0) - (a.score ?? 0) ||
        (a.input.position ?? Infinity) - (b.input.position ?? Infinity) ||
        byKey.compare(a.input.key, b.input.key),
    );
  const numbers = new Map<string, number | null>(scored.map((each) => [each.input.id, null]));
  ranked.forEach((each, index) => numbers.set(each.input.id, index + 1));
  return numbers;
}

/**
 * Whose pool a rank is worked out in: a person's, which is every open task
 * their read grants reach, or an agent's, which is the one task its
 * delegation is working.
 */
export type RankPool =
  { readonly kind: 'grants'; readonly subjects: readonly Subject[] } | { readonly kind: 'task' };

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
    // No business names its priority stages yet, and a task carries no start
    // date: both arrive with the journey stages (MP-5-13) and the task's
    // dates. Until then every task takes a weight of 1 and no age boost, and
    // the calc line says so with its ×1.
    priorityStage: false,
    open: row.open,
    startedAt: null,
  };
}

/**
 * The rank of one task as this reader is shown it. The pool is the open tasks
 * the reader's grants reach, listed by `readableRecordIds` inside the database
 * and handed to the one query that reads the marks, so a task outside the
 * reader's grants is never read here at all. The clock is the database's, the
 * one the grants' expiry reads.
 */
export async function readTaskRank(
  tx: TenantQuery,
  taskTypeId: string,
  recordId: string,
  pool: RankPool,
): Promise<RankView> {
  const readable =
    pool.kind === 'task'
      ? [recordId]
      : await readableRecordIds(tx, pool.subjects, {
          collection: 'task',
          action: 'read',
          recordTypeId: taskTypeId,
        });
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
        and (r.id = $3 or r.id = any($4::uuid[]))`,
    [tx.businessId, taskTypeId, recordId, readable],
  );
  const own = rows.find((row) => row.id === recordId);
  if (own === undefined) return { number: null, score: null, calc: '' };
  const now = own.now;
  const numbers = numberPool(rows.filter((row) => row.open).map(inputOf), now);
  const scored = scoreTask(inputOf(own), now);
  return {
    number: numbers.get(recordId) ?? null,
    score: scored.score,
    calc: calcLine(scored),
  };
}
