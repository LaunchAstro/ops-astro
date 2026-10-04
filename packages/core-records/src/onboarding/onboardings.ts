// SPDX-License-Identifier: AGPL-3.0-only
//
// The onboarding and its steps (C41-A, migration 20261003172353). Every statement runs
// in the caller's tenant transaction, so row-level security keeps another
// business's rows out of every one of them. A step's state moves only here:
// ready when every step it depends on is done, stopped with the rest when one
// step fails twice.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { isRecordsRefusal } from '../records/refusals.ts';
import { nextTaskKey, planTaskPlacement } from '../tasks/placement.ts';
import type { StepKind, TemplateStep } from './template.ts';

export type StepState = 'blocked' | 'ready' | 'done' | 'stopped';

export interface OnboardingStepRow {
  readonly onboardingId: string;
  readonly key: string;
  readonly taskId: string;
  readonly phase: string;
  readonly kind: StepKind;
  readonly dependsOn: readonly string[];
  readonly state: StepState;
  readonly failures: number;
}

interface StepRecord {
  readonly onboarding_id: string;
  readonly step_key: string;
  readonly task_id: string;
  readonly phase: string;
  readonly kind: StepKind;
  readonly depends_on: readonly string[];
  readonly state: StepState;
  readonly failures: number;
}

const STEP_COLUMNS = 'onboarding_id, step_key, task_id, phase, kind, depends_on, state, failures';

const stepOf = (row: StepRecord): OnboardingStepRow => ({
  onboardingId: row.onboarding_id,
  key: row.step_key,
  taskId: row.task_id,
  phase: row.phase,
  kind: row.kind,
  dependsOn: row.depends_on,
  state: row.state,
  failures: row.failures,
});

/**
 * One step's task on the client, top level, keyed and ranked the way
 * `task.create` places one; its party slot is the client.
 */
export async function insertStepTask(
  tx: TenantQuery,
  task: {
    readonly taskTypeId: string;
    readonly stateId: string | undefined;
    readonly source: string;
    readonly clientId: string;
    readonly title: string;
  },
): Promise<string> {
  const placement = await planTaskPlacement(tx, task.taskTypeId, {
    parentId: null,
    board: null,
    boardSection: null,
    suppliedKeys: [],
  });
  if (isRecordsRefusal(placement)) throw new Error('onboarding: a top-level task was not placed');
  const id = randomUUID();
  await tx.query(
    `insert into records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)`,
    [
      tx.businessId,
      id,
      task.taskTypeId,
      {
        title: task.title,
        client: task.clientId,
        key: await nextTaskKey(tx, task.taskTypeId),
        source: task.source,
        board_rank: placement.boardRank,
        ...(task.stateId === undefined ? {} : { state: task.stateId }),
      },
    ],
  );
  return id;
}

/**
 * Claim the client's one onboarding, before anything else is written. The
 * unique key is the lock: a second start for the same client waits on the
 * first's row and, once that commits, finds it and claims nothing, so it is
 * refused rather than meeting the key as a fault. Undefined when claimed.
 */
export async function claimOnboarding(
  tx: TenantQuery,
  onboarding: {
    readonly clientId: string;
    readonly templateKey: string;
    readonly templateVersion: number;
    readonly startedBy: string;
  },
): Promise<string | undefined> {
  const rows = await tx.query<{ readonly id: string }>(
    `insert into public.onboardings
       (business_id, id, client_id, template_key, template_version, started_by_actor_id)
     values ($1, gen_random_uuid(), $2, $3, $4, $5)
     on conflict (business_id, client_id) do nothing
     returning id`,
    [
      tx.businessId,
      onboarding.clientId,
      onboarding.templateKey,
      onboarding.templateVersion,
      onboarding.startedBy,
    ],
  );
  return rows[0]?.id;
}

/** One step row per template step, in template order. */
export async function insertSteps(
  tx: TenantQuery,
  id: string,
  steps: readonly (TemplateStep & { readonly taskId: string })[],
): Promise<readonly OnboardingStepRow[]> {
  const rows = await tx.query<StepRecord>(
    `insert into public.onboarding_steps
       (business_id, onboarding_id, step_key, task_id, position, phase, kind, depends_on, state)
     select $1, $2, s.key, s.task_id, s.position, s.phase, s.kind,
            array(select jsonb_array_elements_text(s.depends_on)),
            case when jsonb_array_length(s.depends_on) = 0 then 'ready' else 'blocked' end
       from jsonb_to_recordset($3::text::jsonb)
         as s (key text, task_id uuid, position integer, phase text, kind text, depends_on jsonb)
     returning ${STEP_COLUMNS}`,
    [
      tx.businessId,
      id,
      JSON.stringify(
        steps.map((step, position) => ({
          key: step.key,
          task_id: step.taskId,
          position,
          phase: step.phase,
          kind: step.kind,
          depends_on: step.dependsOn,
        })),
      ),
    ],
  );
  const byKey = new Map(rows.map((row) => [row.step_key, stepOf(row)]));
  return steps.flatMap((step) => byKey.get(step.key) ?? []);
}

/**
 * The step on this task, with its onboarding locked first, then every step of
 * it, so two results on one onboarding serialise and each sees the other's
 * closed dependencies, and then the step's own task (S0-5: a step's result is
 * content on it). Undefined when no step is on the task, or when the task, read
 * again under its row lock, is no longer on the onboarding's client.
 */
export async function lockStepOfTask(
  tx: TenantQuery,
  taskId: string,
): Promise<
  | {
      readonly onboardingState: string;
      readonly step: OnboardingStepRow;
      readonly siblings: readonly OnboardingStepRow[];
    }
  | undefined
> {
  // The step's own task must still be on the onboarding's client: a task
  // moved to another client is no longer this onboarding's step to close.
  const found = await tx.query<{ readonly onboarding_id: string }>(
    `select s.onboarding_id
       from public.onboarding_steps s
       join public.onboardings o on o.business_id = s.business_id and o.id = s.onboarding_id
       join public.records r on r.business_id = s.business_id and r.id = s.task_id
      where s.business_id = $1 and s.task_id = $2 and r.uuid_7 = o.client_id`,
    [tx.businessId, taskId],
  );
  const onboardingId = found[0]?.onboarding_id;
  if (onboardingId === undefined) return undefined;
  const onboarding = await tx.query<{ readonly state: string; readonly client_id: string }>(
    'select state, client_id from public.onboardings where business_id = $1 and id = $2 for update',
    [tx.businessId, onboardingId],
  );
  const steps = await tx.query<StepRecord>(
    `select ${STEP_COLUMNS} from public.onboarding_steps
      where business_id = $1 and onboarding_id = $2 order by position for update`,
    [tx.businessId, onboardingId],
  );
  // A client change holding the task's lock is waited on here, and the
  // client it committed is the one read: `task.set_party` takes this lock
  // first and no onboarding lock, so the order cannot cross.
  const task = await tx.query<{ readonly client_id: string | null }>(
    'select uuid_7 as client_id from public.records where business_id = $1 and id = $2 for update',
    [tx.businessId, taskId],
  );
  const all = steps.map((row) => stepOf(row));
  const step = all.find((one) => one.taskId === taskId);
  const [held] = onboarding;
  if (step === undefined || held === undefined) return undefined;
  if (task[0]?.client_id !== held.client_id) return undefined;
  return { onboardingState: held.state, step, siblings: all };
}

/**
 * Close a step and open every step whose dependencies are now all done. The
 * onboarding is done when no step is left open. Returns the keys it opened.
 */
export async function closeStep(
  tx: TenantQuery,
  step: OnboardingStepRow,
  siblings: readonly OnboardingStepRow[],
): Promise<readonly string[]> {
  await tx.query(
    `update public.onboarding_steps set state = 'done', closed_at = now()
      where business_id = $1 and onboarding_id = $2 and step_key = $3`,
    [tx.businessId, step.onboardingId, step.key],
  );
  const done = new Set([
    step.key,
    ...siblings.filter((one) => one.state === 'done').map((one) => one.key),
  ]);
  const opened = siblings
    .filter((one) => one.state === 'blocked' && one.dependsOn.every((key) => done.has(key)))
    .map((one) => one.key);
  if (opened.length > 0) {
    await tx.query(
      `update public.onboarding_steps set state = 'ready'
        where business_id = $1 and onboarding_id = $2 and step_key = any($3::text[])`,
      [tx.businessId, step.onboardingId, opened],
    );
  }
  if (done.size === siblings.length) {
    await tx.query(
      `update public.onboardings set state = 'done', revision = revision + 1
        where business_id = $1 and id = $2`,
      [tx.businessId, step.onboardingId],
    );
  }
  return opened;
}

/**
 * Count one failure. The second stops the step and the whole onboarding, so
 * nothing further runs until a person restarts it (CS-15.4: twice failed, it
 * stops and reports). Returns whether it stopped.
 */
export async function failStep(tx: TenantQuery, step: OnboardingStepRow): Promise<boolean> {
  const stops = step.failures + 1 >= 2;
  await tx.query(
    `update public.onboarding_steps
        set failures = failures + 1, state = case when $4 then 'stopped' else state end
      where business_id = $1 and onboarding_id = $2 and step_key = $3`,
    [tx.businessId, step.onboardingId, step.key, stops],
  );
  if (stops) {
    await tx.query(
      `update public.onboardings
          set state = 'stopped', stopped_at = now(), revision = revision + 1
        where business_id = $1 and id = $2`,
      [tx.businessId, step.onboardingId],
    );
  }
  return stops;
}
