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
// The entry is written as soon as the provider answers, in its own
// transaction, under the actor holding the dispatching lease, whether or not
// that lease is still live: an effect that happened still happened (as
// `observe.ts` says of an expired lease). Receipt L's observations stay in
// `live_correction_receipts`, written under the live lease beside it.
//
// Read only after the correction is read under the run's lease, in this
// business only, and only as written by an actor that held a lease on the
// correction's task: a member presenting the same identity for a command of
// their own is not the effect.

import { randomUUID } from 'node:crypto';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import type { Database, LiveCorrection, TenantQuery } from '../../../core-records/src/index.ts';
import type { Accepted } from '../../../core-connectors/src/index.ts';
import { effectOperationId } from '../../../core-wire/src/index.ts';

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
  /** When the revert was decided: its interval is timed from here. */
  readonly decidedAt?: string;
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
  const dispatchToken = text(detail?.['dispatchToken']);
  const decidedAt = text(detail?.['decidedAt']);
  return {
    operationId,
    revision,
    deploymentId,
    ...(dispatchToken === undefined ? {} : { dispatchToken }),
    ...(decidedAt === undefined ? {} : { decidedAt }),
  };
}

/** The accepted publish the register holds, rebuilt for observing it again. */
export function acceptedOf(
  correction: Pick<LiveCorrection, 'pageUrl'>,
  effect: RegisteredEffect,
): Accepted | undefined {
  if (effect.dispatchToken === undefined) return undefined;
  return {
    state: 'accepted',
    revision: effect.revision,
    deploymentId: effect.deploymentId,
    liveUrl: correction.pageUrl,
    dispatchToken: effect.dispatchToken,
  };
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/**
 * The effect the provider accepted, applied in the register under the actor
 * holding the dispatching lease. A second answer under the same identity
 * writes nothing: the first is the effect. False when the lease is not one on
 * the correction's task, so nothing could be written under it.
 */
export async function registerCorrectionEffect(
  db: Database,
  run: { readonly business: string; readonly leaseId: string },
  correction: Pick<LiveCorrection, 'id' | 'taskId'>,
  step: EffectStep,
  answer: EffectAnswer,
): Promise<boolean> {
  const operationId = correctionEffectId(correction.id, step);
  const detail = { ...answer };
  return await db.withBusiness(run.business, async (tx) => {
    const holders = await tx.query<{ readonly holder_actor_id: string }>(
      `select holder_actor_id from public.leases
        where business_id = $1 and id = $2 and task_id = $3`,
      [tx.businessId, run.leaseId, correction.taskId],
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

/** Whether the correction's latest revert receipt recorded an unknown outcome. */
export async function revertLeftUnknown(tx: TenantQuery, correctionId: string): Promise<boolean> {
  const rows = await tx.query<{ readonly outcome: string }>(
    `select outcome from public.live_correction_receipts
      where business_id = $1 and correction_id = $2 and step = 'revert'
      order by created_at desc, id desc limit 1`,
    [tx.businessId, correctionId],
  );
  return rows[0]?.outcome === 'unknown';
}
