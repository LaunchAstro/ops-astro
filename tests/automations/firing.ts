// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A's firing helpers over C33's world: adopt a released version, claim,
// dispatch, revoke and turn off, each in the first business's own
// transaction. Starting the run is the agent engine's (AW-01 J), which C52-A
// does not wire, so dispatch is handed a starter that lists what it was asked
// to start and answers a run id of its own.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import {
  adoptVersion,
  dispatchOccurrence,
  insertActivation,
  insertDefinition,
  readActivation,
  releaseVersion,
  revokeApproval,
  turnOffActivation,
  type ActivationRow,
  type DefinitionVersionRow,
  type Dispatch,
  type OccurrenceClaim,
  type OccurrenceRow,
  type RevokeResult,
  type RunRequest,
  type RunStarter,
  type StandingApprovalRow,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import { DIGEST, type AutomationWorld } from './world.ts';

export interface Approved {
  readonly version: DefinitionVersionRow;
  readonly activation: ActivationRow;
  readonly approval: StandingApprovalRow;
}

export interface Starter {
  readonly runs: RunRequest[];
  readonly start: RunStarter;
}

export function starter(): Starter {
  const runs: RunRequest[] = [];
  return {
    runs,
    start(_tx, run) {
      runs.push(run);
      return Promise.resolve(randomUUID());
    },
  };
}

export function occurrenceOf(claim: OccurrenceClaim): OccurrenceRow {
  if (claim.kind !== 'claimed' && claim.kind !== 'replayed') {
    throw new Error(`the claim answered ${claim.kind}`);
  }
  return claim.occurrence;
}

/** Statements of this database waiting on a lock. */
export const LOCK_WAITS = `select count(*)::text as n from pg_stat_activity
  where datname = current_database() and wait_event_type = 'Lock'`;

/** Polls until `count` statements of the world's database wait on a lock. */
export async function waitingOn(w: AutomationWorld, count: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling until the other side waits
    const waiting = await w.count(LOCK_WAITS);
    if (waiting >= count) return;
    if (Date.now() > deadline) throw new Error(`only ${String(waiting)} of ${count} ever waited`);
    // eslint-disable-next-line no-await-in-loop -- as above
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

/** Bravo's own automation in `mode`, released, activated and adopted by bravo's admin. */
export async function bravoApproved(
  w: AutomationWorld,
  mode: 'scheduled' | 'event',
  name: string,
): Promise<{ readonly activationId: string; readonly approvalId: string }> {
  return await w.db.app.withBusiness(w.bravo, async (tx: TenantQuery) => {
    const actorId = w.bravoAdmin.actorId;
    const definitionId = await insertDefinition(tx, { kind: 'automation', name, actorId });
    const version = await releaseVersion(tx, {
      definitionId,
      contentDigest: DIGEST,
      contentSize: 1234,
      inputs: [],
      operations: ['report.send'],
      modes: [mode],
      actorId,
    });
    if (version === null || version === 'raced') throw new Error(`bravo released ${version}`);
    const activation = await insertActivation(tx, {
      versionId: version.id,
      mode,
      everyMinutes: mode === 'scheduled' ? 60 : null,
      eventKind: mode === 'event' ? 'invoice.paid' : null,
      enabled: true,
      actorId,
    });
    if (activation === null) throw new Error('bravo activation not written');
    const adopted = await adoptVersion(tx, {
      activationId: activation.id,
      versionId: version.id,
      expectedRevision: activation.revision,
      act: 'adopted',
      actorId,
    });
    if (adopted.kind !== 'adopted') throw new Error(`bravo adoption ${adopted.kind}`);
    return { activationId: activation.id, approvalId: adopted.approval.id };
  });
}

export interface Firing {
  nextDue(): Date;
  adopt(activation: ActivationRow, version: DefinitionVersionRow): Promise<Approved>;
  approved(mode?: 'scheduled' | 'event'): Promise<Approved>;
  fire(activationId: string, start: RunStarter): Promise<Dispatch>;
  dispatch(occurrenceId: string, start: RunStarter): Promise<Dispatch>;
  revoke(approvalId: string): Promise<RevokeResult>;
  turnOff(activationId: string): Promise<void>;
  started(activationId: string): Promise<number>;
}

// eslint-disable-next-line max-lines-per-function -- the helpers share the world
export function firingOf(w: AutomationWorld): Firing {
  let hour = 0;
  const nextDue = (): Date => new Date(Date.UTC(2026, 10, 1, (hour += 1)));
  const dispatch = async (occurrenceId: string, start: RunStarter): Promise<Dispatch> =>
    await w.inAlpha((tx) => dispatchOccurrence(tx, occurrenceId, start));
  const adopt = async (
    activation: ActivationRow,
    version: DefinitionVersionRow,
  ): Promise<Approved> => {
    const adopted = await w.inAlpha((tx) =>
      adoptVersion(tx, {
        activationId: activation.id,
        versionId: version.id,
        expectedRevision: activation.revision,
        act: 'adopted',
        actorId: w.admin.actorId,
      }),
    );
    if (adopted.kind !== 'adopted') throw new Error(`the adoption answered ${adopted.kind}`);
    return { version, activation: adopted.activation, approval: adopted.approval };
  };
  return {
    nextDue,
    adopt,
    async approved(mode = 'scheduled') {
      const version = await w.release([mode]);
      return await adopt(await w.activate(version, mode), version);
    },
    async fire(activationId, start) {
      const occurrence = occurrenceOf(await w.claim(activationId, { dueAt: nextDue() }));
      return await dispatch(occurrence.id, start);
    },
    dispatch,
    async revoke(approvalId) {
      return await w.inAlpha((tx) => revokeApproval(tx, { approvalId, actorId: w.admin.actorId }));
    },
    async turnOff(activationId) {
      const now = await w.inAlpha((tx) => readActivation(tx, activationId));
      const off = await w.inAlpha((tx) =>
        turnOffActivation(tx, {
          activationId,
          expectedRevision: now?.revision ?? 0,
          actorId: w.admin.actorId,
        }),
      );
      expect(off.kind).toBe('off');
    },
    async started(activationId) {
      return await w.count(
        `select count(*) as n from public.occurrence_dispatches d
           join public.activation_occurrences o
             on o.business_id = d.business_id and o.id = d.occurrence_id
          where o.activation_id = $1 and d.outcome = 'started'`,
        [activationId],
      );
    },
  };
}
