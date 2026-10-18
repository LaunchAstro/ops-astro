// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R1: how the outcome proofs read what a stop recorded. The stop
// writers' proofs read `run_outcomes` through the admin connection, by the
// attempt the presented lease belongs to, so a stop that wrote no row reads
// as no row: on a tree without the table, the red is "no outcome recorded",
// never a missing relation.

/** The admin connection's statement runner, as the test worlds expose it. */
export interface AdminSql {
  execute<Row>(text: string, parameters: readonly unknown[]): Promise<readonly Row[]>;
}

/** One stored outcome, as the stop wrote it. */
export interface OutcomeRow {
  readonly attempt_id: string;
  readonly planned_run_id: string;
  readonly outcome: string;
  readonly end_code: string;
  readonly stop_cause: string | null;
}

const tableExists = async (admin: AdminSql): Promise<boolean> => {
  const [found] = await admin.execute<{ readonly present: boolean }>(
    `select to_regclass('public.run_outcomes') is not null as present`,
    [],
  );
  return found?.present === true;
};

/** Every outcome recorded for one attempt: one at most once a stop has written. */
export async function outcomesOfAttempt(
  admin: AdminSql,
  businessId: string,
  attemptId: string,
): Promise<readonly OutcomeRow[]> {
  if (!(await tableExists(admin))) return [];
  return await admin.execute<OutcomeRow>(
    `select attempt_id::text as attempt_id, planned_run_id::text as planned_run_id,
            outcome, end_code, stop_cause
       from public.run_outcomes where business_id = $1 and attempt_id = $2`,
    [businessId, attemptId],
  );
}

/** Every outcome recorded on one run, oldest attempt first. */
export async function outcomesOfRun(
  admin: AdminSql,
  businessId: string,
  runId: string,
): Promise<readonly OutcomeRow[]> {
  if (!(await tableExists(admin))) return [];
  return await admin.execute<OutcomeRow>(
    `select o.attempt_id::text as attempt_id, o.planned_run_id::text as planned_run_id,
            o.outcome, o.end_code, o.stop_cause
       from public.run_outcomes o
       join public.attempts a on a.business_id = o.business_id and a.id = o.attempt_id
      where o.business_id = $1 and o.planned_run_id = $2
      order by a.created_at, a.id`,
    [businessId, runId],
  );
}

/** The attempt a lease serves: the one a stop on that lease records against. */
export async function attemptOfLease(
  admin: AdminSql,
  businessId: string,
  leaseId: string,
): Promise<{ readonly attemptId: string; readonly runId: string }> {
  const [found] = await admin.execute<{ readonly attempt_id: string; readonly run_id: string }>(
    `select a.id::text as attempt_id, l.run_id::text as run_id
       from public.leases l
       join public.attempts a on a.business_id = l.business_id and a.lease_id = l.id
      where l.business_id = $1 and l.id = $2`,
    [businessId, leaseId],
  );
  if (found === undefined) throw new Error('the lease serves no attempt');
  return { attemptId: found.attempt_id, runId: found.run_id };
}
