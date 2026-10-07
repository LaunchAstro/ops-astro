// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 on the effect register (T2c2): one idempotency and reconciliation
// mechanism in the product. A publish or a revert the provider accepted is an
// applied row in `operations` under the identity derived from the correction
// and its step (`effectOperationId`), the same register a worker's local
// effect answers "did it happen?" from. The runner asks it before it sends:
// an effect the register holds is observed again, never sent again, and an
// unknown outcome with nothing registered waits on a person.
//
// The entry is written as soon as the executable returns the provider's
// acceptance, in its own transaction, under the actor holding the dispatching
// lease, whether or not that lease is still live: an effect that happened
// still happened (as `observe.ts` says of an expired lease). Receipt L's
// observations stay in `live_correction_receipts`, written under the live lease
// beside it.
//
// Read only after the correction is read under the run's lease, in this
// business only, and only as written by an actor that held a lease on the
// correction's task: a member presenting the same identity for a command of
// their own is not the effect.

import { randomUUID } from 'node:crypto';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import {
  readCorrectionForRun,
  recordObservedResult,
  type Database,
  type LiveCorrection,
  type TenantQuery,
  type UnderLease,
} from '../../../core-records/src/index.ts';
import {
  dispatchToken,
  type Accepted,
  type Occurrence,
} from '../../../core-connectors/src/index.ts';
import { effectOperationId } from '../../../core-wire/src/index.ts';
import { observedIn, occurrenceFrom, seen } from './live-correction-observations.ts';

export type EffectStep = 'publish' | 'revert';

/**
 * The register's command for each step: the catalogue's operation, spelt in
 * the register's one-dot shape (`site.source.revert` has two). No command of
 * the surface carries either name, so no request can write one.
 */
const COMMAND: Readonly<Record<EffectStep, string>> = {
  publish: 'site.publish',
  revert: 'site.revert',
};

/** What the provider answered for the effect, as the register keeps it. */
export interface EffectAnswer {
  readonly revision: string;
  readonly deploymentId: string;
  /** The publish's idempotency key at the provider. */
  readonly dispatchToken?: string;
  /** When the runner first took the revert up: its interval is timed from here. */
  readonly decidedAt?: string;
  /** The publish's calibrated place, where its live check reads the word. */
  readonly occurrence?: Occurrence;
}

export interface RegisteredEffect extends EffectAnswer {
  readonly operationId: string;
}

/** The identity of a correction's one effect at one step, derived so a retry presents it again. */
export function correctionEffectId(correctionId: string, step: EffectStep): string {
  return effectOperationId(`${correctionId}.${step}`);
}

/** Did the step's effect happen? The register's answer, or nothing. */
export async function readCorrectionEffect(
  tx: TenantQuery,
  correction: Pick<LiveCorrection, 'id' | 'taskId'>,
  step: EffectStep,
): Promise<RegisteredEffect | undefined> {
  const operationId = correctionEffectId(correction.id, step);
  const rows = await tx.query<{ readonly detail: Record<string, unknown> | null }>(
    `select o.result -> 'detail' as detail
       from public.operations o
      where o.business_id = $1 and o.operation_id = $2 and o.command = $3
        and o.outcome = 'applied' and o.record_id = $4
        and exists (select 1 from public.leases l
                     where l.business_id = o.business_id and l.task_id = $5
                       and l.holder_actor_id = o.actor_id)
      order by o.created_at, o.id
      limit 1`,
    [tx.businessId, operationId, COMMAND[step], correction.id, correction.taskId],
  );
  const detail = rows[0]?.detail;
  const revision = text(detail?.['revision']);
  const deploymentId = text(detail?.['deploymentId']);
  if (revision === undefined || deploymentId === undefined) return undefined;
  const token = text(detail?.['dispatchToken']);
  const decidedAt = text(detail?.['decidedAt']);
  const occurrence = occurrenceFrom(detail?.['occurrence']);
  return {
    operationId,
    revision,
    deploymentId,
    ...(token === undefined ? {} : { dispatchToken: token }),
    ...(decidedAt === undefined ? {} : { decidedAt }),
    ...(occurrence === undefined ? {} : { occurrence }),
  };
}

/**
 * The accepted publish the register holds, rebuilt for observing it again; or
 * nothing when the entry names a token other than the one this correction's
 * approved version dispatches with, so it is not this publish's acceptance.
 */
export function acceptedOf(
  correction: Pick<LiveCorrection, 'pageUrl' | 'versionDigest'>,
  effect: RegisteredEffect,
): Accepted | undefined {
  const sent = dispatchToken('site.publish', correction.versionDigest);
  if (effect.dispatchToken !== sent) return undefined;
  return {
    state: 'accepted',
    revision: effect.revision,
    deploymentId: effect.deploymentId,
    liveUrl: correction.pageUrl,
    dispatchToken: sent,
    occurrence: effect.occurrence,
  };
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/**
 * The effect the provider accepted, applied in the register under the actor
 * holding the dispatching lease. A second answer under the same identity
 * writes nothing: the first is the effect. False unless the caller holds the
 * lease, at its fence, on the correction's task.
 */
export async function registerCorrectionEffect(
  db: Database,
  run: Omit<UnderLease, 'correctionId'> & { readonly business: string },
  correction: Pick<LiveCorrection, 'id' | 'taskId'>,
  step: EffectStep,
  answer: EffectAnswer,
): Promise<boolean> {
  const operationId = correctionEffectId(correction.id, step);
  const detail = { ...answer };
  return await db.withBusiness(run.business, async (tx) => {
    const holders = await tx.query<{ readonly holder_actor_id: string }>(
      `select holder_actor_id from public.leases
        where business_id = $1 and id = $2 and task_id = $3
          and holder_actor_id = $4 and fence = $5`,
      [tx.businessId, run.leaseId, correction.taskId, run.actorId, run.fence],
    );
    const actorId = holders[0]?.holder_actor_id;
    if (actorId === undefined) return false;
    await tx.query(
      `insert into public.operations
         (business_id, id, operation_id, command, actor_id, payload_digest, outcome, result,
          record_id, revision)
       values ($1, $2, $3, $4, $5, $6, 'applied', $7::text::jsonb, $8, null)
       on conflict on constraint operations_identity_key do nothing`,
      [
        tx.businessId,
        randomUUID(),
        operationId,
        COMMAND[step],
        actorId,
        payloadDigest({ operationId, ...detail }),
        JSON.stringify({ command: COMMAND[step], recordId: correction.id, revision: null, detail }),
        correction.id,
      ],
    );
    return true;
  });
}

type RevertReceipt = {
  readonly outcome: string;
  readonly observations: Readonly<Record<string, unknown>>;
};

/** The correction's latest revert receipt: its outcome and observations, or nothing. */
export async function latestRevert(
  tx: TenantQuery,
  correctionId: string,
): Promise<RevertReceipt | undefined> {
  const rows = await tx.query<RevertReceipt>(
    `select outcome, observations from public.live_correction_receipts
      where business_id = $1 and correction_id = $2 and step = 'revert'
      order by created_at desc, id desc limit 1`,
    [tx.businessId, correctionId],
  );
  return rows[0];
}

/**
 * The dispatch taken under the effect's lease (one dispatch across overlapping runners): the
 * correction, read under the lease and still `approved` by a person, moves to unknown with its
 * receipt in one transaction. A runner that loses this race, or holds a lost lease, gets the
 * refusal's code and sends nothing; the winner's send can then only be observed.
 */
export async function takeDispatch(
  db: Database,
  run: UnderLease & { readonly business: string },
  token: string,
  approved: (correction: LiveCorrection) => string | undefined,
): Promise<string | undefined> {
  const taken = await db.withBusiness(run.business, async (tx) => {
    const read = await readCorrectionForRun(tx, run);
    if (!read.ok) return read;
    if (approved(read.correction) === undefined) return { ok: false, code: 'OUTCOME_UNKNOWN' };
    const observations = {
      effect_operation_id: seen(correctionEffectId(run.correctionId, 'publish')),
      attempt_and_dispatch_token: seen(token),
    };
    const result = { step: 'publish', outcome: 'unknown', observations } as const;
    return await recordObservedResult(tx, { ...run, ...result });
  });
  return taken.ok ? undefined : taken.code;
}

type Ask = { readonly step: EffectStep; readonly outcome: 'unknown' | 'accepted' };

/**
 * Whether this run is the one to ask a person about an outcome nothing registered. In one
 * transaction under the correction's lock, the step's latest receipt read again: asked
 * (`person`), or being asked under this run's own live lease (`asking`, a concurrent retry),
 * answers no; otherwise `asking` is written under this lease and the answer is yes. An ask
 * left by a lease no longer live (a worker lost while raising the task) is asked again. A
 * lease refusal is its code.
 */
export async function askOnce(
  db: Database,
  run: UnderLease & { readonly business: string },
  at: Ask,
): Promise<boolean | string> {
  const observations = { waits_on: seen('asking'), asked_under: seen(run.leaseId) };
  return await db.withBusiness(run.business, async (tx) => {
    const read = await readCorrectionForRun(tx, run);
    if (!read.ok) return read.code;
    const last =
      at.step === 'publish'
        ? read.lastPublish
        : (await latestRevert(tx, run.correctionId))?.observations;
    const asking = observedIn(last, 'waits_on');
    if (asking === 'person') return false;
    if (asking === 'asking' && observedIn(last, 'asked_under') === run.leaseId) return false;
    const written = await recordObservedResult(tx, { ...run, ...at, observations });
    return written.ok || written.code;
  });
}

/**
 * The ask settled under the lease: `person` once the task was raised, `none` when raising it
 * failed, so the next retry asks again. A crash between the task and `person` leaves `asking`,
 * and a later lease raises a second task: accepted noise, never a lost ask.
 */
export async function settleAsk(
  db: Database,
  run: UnderLease & { readonly business: string },
  at: Ask,
  waitsOn: 'person' | 'none',
): Promise<void> {
  const observations = { waits_on: seen(waitsOn) };
  await db.withBusiness(run.business, (tx) =>
    recordObservedResult(tx, { ...run, ...at, observations }),
  );
}
