// SPDX-License-Identifier: AGPL-3.0-only
//
// Every wrap-up and purge check lists the runs and gates a conversation
// started while it holds the conversation's row lock (conversation-work.ts).
// The list must reach them through the origin-conversation indexes on
// planned_runs, gates and plan_records, never by reading the whole business.
// The business is seeded with thousands of other conversations' runs, gates
// and plan records and analysed, so the planner prices a full read honestly.
// Switching sequential scans off instead would not do: the planner would read
// the business-only index, the same full read under another name. The noise is written with foreign keys off, as it only has to be counted.
// The real rows go through the accept, so the lists still return exactly the
// conversation's own runs and gates, direct and through a plan, and no other
// conversation's or business's.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { workOf } from '../../packages/core-commands/src/commands/conversation-work.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import {
  acceptAs,
  acceptRequest,
  conversationOf,
  noDatabase,
  proposed,
  useAw04World,
  w,
} from '../runtime/aw-04-world.ts';
import type { Schedules } from '../runtime/schedules-harness.ts';

useAw04World('started_work_indexes');

const NOISE = 3000;

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Relation Name'?: string;
  readonly Plans?: readonly PlanNode[];
}

/** The relations a plan reads by a sequential scan, subplans included. */
function seqScanned(node: PlanNode): readonly string[] {
  const own = node['Node Type'] === 'Seq Scan' ? [node['Relation Name'] ?? '?'] : [];
  return [...own, ...(node.Plans ?? []).flatMap((child) => seqScanned(child))];
}

/** `tx`, planning each statement it is asked to run before it runs it. */
function planning(tx: TenantQuery, plans: Map<string, PlanNode>): TenantQuery {
  return {
    businessId: tx.businessId,
    async query<Row>(text: string, parameters?: readonly unknown[]) {
      const [row] = await tx.query<{ 'QUERY PLAN': unknown }>(
        `explain (format json) ${text}`,
        parameters,
      );
      const raw = row?.['QUERY PLAN'];
      const [plan] = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { Plan: PlanNode }[];
      if (plan !== undefined) plans.set(text, plan.Plan);
      return await tx.query<Row>(text, parameters);
    },
  };
}

/** A plan accepted in `owner`'s business, its plan record naming `conversationId`. */
async function accepted(owner: Schedules, conversationId: string | null) {
  const plan = await proposed(owner, `started work ${randomUUID()}`);
  const result = await acceptAs(owner, {
    ...acceptRequest(owner, plan),
    originConversationId: conversationId,
  });
  if (!result.ok) throw new Error(`accept refused: ${JSON.stringify(result)}`);
  return { runId: result.value.runId, gateId: String(plan.proposal['gateId']) };
}

/** The run and gate keep `conversationId` as their own origin. */
async function startedIn(owner: Schedules, ids: { runId: string; gateId: string }, id: string) {
  await owner.db.admin.execute(
    `update public.planned_runs set origin_conversation_id = $2 where id = $1`,
    [ids.runId, id],
  );
  await owner.db.admin.execute(
    `update public.gates set origin_conversation_id = $2 where id = $1`,
    [ids.gateId, id],
  );
}

/** Other conversations' runs, gates and plan records in `owner`'s business, then analysed. */
async function seedNoise(owner: Schedules): Promise<void> {
  await owner.db.admin.transaction(async (execute) => {
    await execute(`set local session_replication_role = replica`);
    await execute(
      `create temporary table noise on commit drop as
       select gen_random_uuid() as run_id, gen_random_uuid() as gate_id,
              case when n % 3 = 0 then ('00000000-0000-4000-8000-' || lpad(to_hex(n % 300), 12, '0'))::uuid end
                as origin
         from generate_series(1, $1::int) n`,
      [NOISE],
    );
    await execute(
      `insert into public.planned_runs
         (business_id, id, lineage_id, version_id, task_id, state, origin_conversation_id)
       select $1, run_id, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'handed_back', origin
         from noise`,
      [owner.business],
    );
    await execute(
      `insert into public.gates
         (business_id, id, lineage_id, version_id, run_id, step_id, evidence_pack_id,
          payload_digest, expires_at, origin_conversation_id)
       select $1, gate_id, gen_random_uuid(), gen_random_uuid(), run_id, gen_random_uuid(),
              gen_random_uuid(), repeat('a', 64), now() + interval '1 day', origin
         from noise`,
      [owner.business],
    );
    await execute(
      `insert into public.plan_records
         (business_id, id, gate_id, decision_id, run_id, origin_conversation_id, plan_text,
          text_digest, record, record_digest, bound_by_actor_id)
       select $1, gen_random_uuid(), gate_id, gen_random_uuid(), run_id,
              ('00000000-0000-4000-8000-' || lpad(to_hex(row_number() over () % 300), 12, '0'))::uuid,
              'noise', repeat('b', 64), '{}', repeat('c', 64), gen_random_uuid()
         from noise`,
      [owner.business],
    );
  });
  await owner.db.admin.execute(`analyze public.planned_runs, public.gates, public.plan_records`);
}

it.skipIf(noDatabase)(
  "a conversation's started runs and gates are read through indexes, and are exactly its own",
  async () => {
    const { alpha, bravo } = w;
    const ours = await conversationOf(alpha, alpha.decider);
    const other = await conversationOf(alpha, alpha.decider);
    const bravoOwn = await conversationOf(bravo, bravo.decider);
    const throughPlan = await accepted(alpha, ours);
    const direct = await accepted(alpha, null);
    await startedIn(alpha, direct, ours);
    const elsewhere = await accepted(alpha, other);
    const otherDirect = await accepted(alpha, null);
    await startedIn(alpha, otherDirect, other);
    const inBravo = await accepted(bravo, bravoOwn);
    await startedIn(bravo, inBravo, bravoOwn);
    await seedNoise(alpha);

    const plans = new Map<string, PlanNode>();
    const work = await alpha.db.app.withBusiness(
      alpha.business,
      async (tx) => await workOf(planning(tx, plans), ours, null),
    );

    // The run list and the gate list, by the relation each lists; the task
    // and audit reads before them touch none of the three.
    const scanned = Object.fromEntries(
      [...plans]
        .filter(([text]) => /planned_runs|from gates/u.test(text))
        .map(([text, plan]) => [
          text.includes('from planned_runs') ? 'runs' : 'gates',
          seqScanned(plan).filter((relation) =>
            ['planned_runs', 'gates', 'plan_records'].includes(relation),
          ),
        ]),
    );
    expect(scanned).toEqual({ runs: [], gates: [] });

    const ids = (kind: string) =>
      work.filter((item) => item.pointer.kind === kind).map((item) => item.pointer.id);
    expect({ runs: ids('run'), gates: ids('gate') }).toEqual({
      runs: [throughPlan.runId, direct.runId].toSorted(),
      gates: [throughPlan.gateId, direct.gateId].toSorted(),
    });
    for (const foreign of [elsewhere, otherDirect, inBravo]) {
      expect(JSON.stringify(work)).not.toContain(foreign.runId);
      expect(JSON.stringify(work)).not.toContain(foreign.gateId);
    }
  },
  180_000,
);
