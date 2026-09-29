// SPDX-License-Identifier: AGPL-3.0-only
//
// The T3b suite's harness (`t3b-sweeper.test.ts`): a second business in the
// same database, work driven by a usage reporter handed in at construction,
// the sweep run as the API runs it, and the rows a sweep may move. Kept apart
// so the suite stays under the per-file cap.

import { randomUUID } from 'node:crypto';
import { sweepExpiredLeases } from '../../packages/core-runtime/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { effectOperationId } from '../../packages/core-wire/src/index.ts';
import type { UsageReporter } from '../../apps/worker/usage.ts';
import { insertBusiness, insertLogin } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine } from '../commands/fixture.ts';
import { appliedDetail, asAgent, rows, type Schedules } from './schedules-harness.ts';
import { t2dHarness, type Work } from './t2d-harness.ts';

/** Another business on the same database, set up as `openSchedules` sets up the first. */
export async function openSecond(s: Schedules, key: string): Promise<Schedules> {
  const business = (await insertBusiness(s.db.app, `t3b-${key}`)) as BusinessId;
  await installSpine(s.db.app, business);
  const decider = await enrol(s.db.app, business, `${key}-decider`);
  const capId = randomUUID();
  const agentActorId = randomUUID();
  const subject = `agent-${randomUUID()}`;
  await s.db.app.withBusiness(business, async (tx) => {
    for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
      // Sequential: `issueGrant` reads the granter's own rows.
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, decider, action, undefined, true);
    }
    await tx.query(
      `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
       values ($1, $2, 'local', 1000000, 'AUD')`,
      [business, capId],
    );
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      business,
      agentActorId,
    ]);
    const loginId = await insertLogin(tx, subject);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [business, randomUUID(), loginId, agentActorId, decider.actorId],
    );
  });
  return { ...s, business, decider, agent: { provider: 'supabase', subject }, agentActorId, capId };
}

export const STEP = { kind: 'synthetic_comment' } as const;

export interface T3bHarness {
  readonly work: () => Promise<Work>;
  /** Dispatch, apply the one effect, and observe it with what `reporter` says it cost. */
  readonly reported: (w: Work, reporter: UsageReporter) => Promise<void>;
  readonly dispatched: (w: Work) => Promise<void>;
  readonly money: (w: Work) => Promise<Record<string, unknown> | undefined>;
  /** The lease's deadline moved behind the database clock: a timer advanced past its window. */
  readonly expire: (w: Work) => Promise<void>;
  readonly sweep: () => ReturnType<typeof sweepExpiredLeases>;
  /** Everything money or work in this business, for before-and-after comparison. */
  readonly snapshot: () => Promise<readonly unknown[]>;
  readonly effects: (w: Work) => Promise<number>;
}

export function t3bHarness(get: () => Schedules): T3bHarness {
  const t2d = t2dHarness(get);

  const reported = async (w: Work, reporter: UsageReporter): Promise<void> => {
    await t2d.applied(w);
    appliedDetail(
      await t2d.held(w, {
        command: 'task.observe',
        attemptId: w.attemptId,
        usage: reporter.observe(STEP),
      }),
      'task.observe',
    );
  };

  const money = async (w: Work) =>
    (
      await rows<Record<string, unknown>>(
        get(),
        `select res.state, res.held_minor::text as held, res.actual_minor::text as actual,
                res.classified_cause, att.state as attempt_state, att.dispatch_marker,
                env.held_minor::text as envelope_held, env.actual_minor::text as envelope_actual,
                l.state as lease_state
           from public.reservations res
           join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
           join public.task_envelopes env on env.business_id = res.business_id and env.id = res.envelope_id
           left join public.leases l on l.business_id = res.business_id and l.id = res.lease_id
          where res.business_id = $1 and res.id = $2`,
        [get().business, w.decision['reservationId']],
      )
    )[0];

  const expire = async (w: Work): Promise<void> => {
    await get().db.admin.execute(
      `update public.leases set expires_at = clock_timestamp() - interval '1 second'
        where business_id = $1 and id = $2`,
      [get().business, w.picked['leaseId']],
    );
  };

  const snapshot = async () =>
    await rows(
      get(),
      `select 'reservation' as kind, id::text, state, held_minor::text as a, actual_minor::text as b
         from public.reservations where business_id = $1
       union all
       select 'attempt', id::text, state, dispatch_marker::text, observed::text
         from public.attempts where business_id = $1
       union all
       select 'lease', id::text, state, fence::text, null from public.leases where business_id = $1
       union all
       select 'envelope', id::text, state, held_minor::text, actual_minor::text
         from public.task_envelopes where business_id = $1
       order by 1, 2`,
      [get().business],
    );

  const effects = async (w: Work): Promise<number> =>
    (
      await rows(
        get(),
        `select 1 from public.operations where business_id = $1 and operation_id = $2`,
        [get().business, effectOperationId(w.attemptId)],
      )
    ).length;

  const sweep = async () =>
    await get().db.app.withBusiness(get().business, async (tx) => await sweepExpiredLeases(tx));

  const dispatched = async (w: Work): Promise<void> => {
    await t2d.dispatched(w);
  };

  return {
    work: t2d.work,
    reported,
    dispatched,
    money,
    expire,
    sweep,
    snapshot,
    effects,
  };
}

/** An agent call on the work's own lease. */
export async function onLease(
  s: Schedules,
  w: Work,
  body: Readonly<Record<string, unknown>>,
): ReturnType<typeof asAgent> {
  return await asAgent(
    s,
    { operationId: randomUUID(), leaseId: w.picked['leaseId'], fence: w.picked['fence'], ...body },
    w.credential,
  );
}
