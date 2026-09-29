// SPDX-License-Identifier: AGPL-3.0-only
//
// T4b1: the facts one journey leaves in the database, read back so two passes
// can be compared (`journey_twice_same_facts`, split section 3.2). A pass is
// the whole propose, decide, apply, settle journey for one task; the facts are
// its decision, its receipt, its reservations and attempts, its run events,
// its audited writes and its alerts.
//
// Identifiers, times, digests and signatures differ between two honest runs,
// so they are replaced before comparing: an identifier by the order in which
// it first appears (`<id 3>`), a time by `<time>`, a digest or signature key
// dropped. What is left is what the two surfaces have to agree on.
//
// A comparison with a side missing, or a side that recorded no decision, no
// receipt, no reservation or no event, is refused as a failure, never reported
// as agreement: one pass that did nothing matches another that did nothing.

import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';

export interface JourneyFacts {
  readonly decisions: readonly unknown[];
  readonly receipt: unknown;
  readonly reservations: readonly unknown[];
  readonly attempts: readonly unknown[];
  readonly events: readonly unknown[];
  readonly audit: readonly unknown[];
  readonly alerts: readonly unknown[];
}

export interface Comparison {
  readonly ok: boolean;
  /** One line per disagreement, or per side that cannot be compared. */
  readonly failures: readonly string[];
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/u;
/** Digests, the chain's links and its business-wide position, and times: they differ per run. */
const DROPPED = /digest|hash|signature|signing|^(evidence|prev|seq)$|(_at|At)$/u;

/** Replace identifiers and times, drop digests, sort keys: the comparable form. */
export function normalise(value: unknown, ids: Map<string, string> = new Map()): unknown {
  if (typeof value === 'string') {
    if (TIME.test(value)) return '<time>';
    // Embedded ones too: an effect's operation identity is `effect:<attempt>`.
    return value.replaceAll(UUID, (id) => {
      const known = ids.get(id) ?? `<id ${String(ids.size + 1)}>`;
      ids.set(id, known);
      return known;
    });
  }
  if (value instanceof Date) return '<time>';
  if (Array.isArray(value)) return value.map((item) => normalise(item, ids));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).toSorted()) {
      if (!DROPPED.test(key)) out[key] = normalise((value as Record<string, unknown>)[key], ids);
    }
    return out;
  }
  // bigint columns come back as strings from the driver; numbers stay numbers.
  return value;
}

/**
 * Every fact the journey on `taskId` left, business-scoped in each query, read
 * on the administrative connection so the read itself adds no audit event.
 * `receipt` is the `task.receipt` answer the pass was given.
 */
export async function readFacts(
  admin: AdminConnection,
  businessId: string,
  taskId: string,
  receipt: unknown,
): Promise<JourneyFacts> {
  const rows = async (sql: string): Promise<readonly Record<string, unknown>[]> =>
    await admin.execute<Record<string, unknown>>(sql, [businessId, taskId]);
  const runs = `select id from public.planned_runs where business_id = $1 and task_id = $2`;
  const facts = {
    decisions: await rows(
      `select d.decision, d.round, d.payload, d.decided_by_person_id
         from public.gate_decisions d
         join public.gates g on g.business_id = d.business_id and g.id = d.gate_id
         join public.proposal_lineages l on l.business_id = g.business_id and l.id = g.lineage_id
        where d.business_id = $1 and l.task_id = $2 order by d.seq`,
    ),
    receipt,
    reservations: await rows(
      `select state, held_minor, actual_minor, classified_cause from public.reservations
        where business_id = $1 and run_id in (${runs}) order by created_at, id`,
    ),
    attempts: await rows(
      `select state, outcome, estimated_minor, actual_minor, dispatch_marker, observed,
              synthetic, provider, model, price_book, drop_cause
         from public.attempts where business_id = $1 and run_id in (${runs})
        order by created_at, id`,
    ),
    events: await rows(
      `select position, kind, detail from public.run_events
        where business_id = $1 and task_id = $2 order by position`,
    ),
    audit: await rows(
      `select command, outcome, refusal_code from public.audit_events
        where business_id = $1 and subject_record_id = $2 and operation_id is not null
        order by seq`,
    ),
    alerts: await rows(
      `select kind, waiting_reason from public.alerts
        where business_id = $1 and task_id = $2 order by raised_at, id`,
    ),
  };
  return normalise(facts) as JourneyFacts;
}

const REQUIRED: readonly (keyof JourneyFacts)[] = [
  'decisions',
  'receipt',
  'reservations',
  'events',
];

function missing(side: string, facts: JourneyFacts | undefined): string[] {
  if (facts === undefined) return [`one-sided: the ${side} pass did not run`];
  return REQUIRED.filter((key) => {
    const value = facts[key];
    return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
  }).map((key) => `one-sided: the ${side} pass recorded no ${key}`);
}

/** The app pass's facts against the command line's, key by key. */
export function compareFacts(app?: JourneyFacts, cli?: JourneyFacts): Comparison {
  const refused = [...missing('app', app), ...missing('cli', cli)];
  if (refused.length > 0 || app === undefined || cli === undefined) {
    return { ok: false, failures: refused };
  }
  const failures: string[] = [];
  for (const key of Object.keys(app).toSorted() as (keyof JourneyFacts)[]) {
    const left = JSON.stringify(app[key]);
    const right = JSON.stringify(cli[key]);
    if (left !== right) failures.push(`${key} differ: app ${left} cli ${right}`);
  }
  return { ok: failures.length === 0, failures };
}
