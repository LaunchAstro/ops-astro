// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05's answers, the shared half: a run stopped at its ceiling, the people
// who may answer it, and the rows an answer moves, read as the administrator
// so a refusal can be shown to have written nothing.

import { beforeAll } from 'vitest';
import { writeBusinessSetting, type Database } from '../../packages/core-records/src/index.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import type { BudgetAnswerRequest } from '../../packages/core-runtime/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { liveWork, type Work } from '../runtime/schedules-harness.ts';
import { call, noDatabase, s, world } from './broker-world.ts';

/** The replay operation's priced maximum is 500 minor units: a 400 ceiling cannot hold one call. */
export const UNDER_ONE_CALL = 400;

export interface People {
  /** Holds `billing:decide` and `gate:decide`; approved every plan (the harness's decider). */
  readonly approver: Member;
  /** Holds `billing:decide` and `gate:decide`; approved nothing. */
  readonly second: Member;
  /** Holds `billing:decide`; approved nothing. */
  readonly third: Member;
  /** A member of the business with neither grant. */
  readonly bare: Member;
}

export let people: People;

/** Installs the settings and hands out the money and gate grants, once per file. */
export function usePeople(): void {
  beforeAll(async () => {
    if (noDatabase) return;
    const second = await enrol(s.db.app, s.business, 'second');
    const third = await enrol(s.db.app, s.business, 'third');
    const bare = await enrol(s.db.app, s.business, 'bare');
    await s.db.app.withBusiness(s.business, async (tx) => {
      await installBusinessSettings(tx);
      for (const member of [s.decider, second]) {
        // Sequential: `issueGrant` reads the granter's own rows.
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, member, 'decide', undefined, false, 'billing');
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, member, 'decide', undefined, false, 'gate');
      }
      await grantTo(tx, third, 'decide', undefined, false, 'billing');
    });
    people = { approver: s.decider, second, third, bare };
  }, 60_000);
}

/** A person's answer: the caller and every subject the grant model reads for them. */
export function as(member: Member, runId: string): BudgetAnswerRequest {
  return {
    runId,
    caller: { kind: 'person', personId: member.personId, actorId: member.actorId },
    subjects: [
      { kind: 'person', id: member.personId },
      { kind: 'actor', id: member.actorId },
    ],
  };
}

/** The four-eyes band, in the setting's own unit (dollars), through its owning operation. */
export async function setThreshold(
  value: number | null,
  database: Database = s.db.app,
): Promise<void> {
  await database.withBusiness(s.business, async (tx) => {
    await writeBusinessSetting(tx, {
      key: 'four_eyes_threshold',
      value,
      owningOperation: 'settings.set_four_eyes_threshold',
      actorId: s.decider.actorId,
    });
  });
}

export const one = async <Row>(sql: string, params: readonly unknown[]): Promise<Row> => {
  const [row] = await s.db.admin.execute<Row>(sql, params);
  if (row === undefined) throw new Error(`no row for: ${sql.slice(0, 60)}`);
  return row;
};

/** A run stopped at its ceiling: one ask raised, the lease over, the hold kept. */
export async function stopped(title: string): Promise<{ work: Work; runId: string }> {
  const work = await liveWork(s, title, UNDER_ONE_CALL);
  world.provider.mode('answer');
  const result = await call(work);
  if (result.ok) throw new Error('stopped: the call past the ceiling was not refused');
  const { run_id: runId } = await one<{ run_id: string }>(
    `select run_id from public.leases where id = $1`,
    [work.picked['leaseId']],
  );
  return { work, runId };
}

/** Everything an answer may move, as one comparable row. */
export interface Money {
  readonly run: string;
  readonly reservation: string;
  readonly held: string;
  readonly maximum: string;
  readonly envelope_held: string;
  readonly envelope_actual: string;
  readonly cap_committed: string;
  readonly answers: number;
  readonly approvals: number;
  readonly asks: number;
}

export async function moneyOf(runId: string): Promise<Money> {
  return await one<Money>(
    `select run.state as run, r.state as reservation, r.held_minor::text as held,
            e.maximum_minor::text as maximum, e.held_minor::text as envelope_held,
            e.actual_minor::text as envelope_actual,
            (select coalesce(sum(o.held_minor + o.actual_minor), 0)::text
               from public.task_envelopes o where o.cap_id = e.cap_id) as cap_committed,
            (select count(*)::int from public.budget_answers a where a.run_id = run.id) as answers,
            (select count(*)::int from public.budget_approvals p where p.run_id = run.id) as approvals,
            (select count(*)::int from public.budget_asks k where k.run_id = run.id) as asks
       from public.planned_runs run
       join lateral (select * from public.reservations x where x.run_id = run.id
                      order by x.created_at desc limit 1) r on true
       join public.task_envelopes e on e.id = r.envelope_id
      where run.id = $1`,
    [runId],
  );
}

/**
 * A crash at one write: a trigger that fails that table's statement, planted
 * in this file's own database and dropped after, so the answer's transaction
 * goes back at exactly that step.
 */
export async function failingAt<T>(
  table: string,
  event: 'insert' | 'update',
  run: () => Promise<T>,
): Promise<unknown> {
  const name = `aw05_crash_${table}_${event}`;
  await s.db.admin.execute(
    `create or replace function public.${name}() returns trigger language plpgsql as $$
     begin raise exception 'planted crash at ${table} ${event}'; end $$`,
    [],
  );
  await s.db.admin.execute(
    `create trigger ${name} before ${event} on public.${table}
       for each row execute function public.${name}()`,
    [],
  );
  try {
    return await run().then(
      () => 'no crash',
      (cause: unknown) => cause,
    );
  } finally {
    await s.db.admin.execute(`drop trigger ${name} on public.${table}`, []);
    await s.db.admin.execute(`drop function public.${name}()`, []);
  }
}
