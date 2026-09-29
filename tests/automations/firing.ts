// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A's firing helpers over C33's world: adopt a released version, claim,
// dispatch, revoke and turn off, each in the first business's own transaction.
// The run is the agent engine's (AW-01, not on this branch), so dispatch is
// handed a run starter that counts what it is asked to start.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import {
  adoptVersion,
  dispatchOccurrence,
  readActivation,
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
} from '../../packages/core-records/src/index.ts';
import type { AutomationWorld } from './world.ts';

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
