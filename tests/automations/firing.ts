// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A's firing helpers over C33's world: adopt a released version, claim,
// dispatch, revoke and turn off, each in the first business's own transaction.
// Dispatch is handed the product's run starter for the world's worker (AW-01
// J's write), wrapped to list the runs it started.

import { expect } from 'vitest';
import { occurrenceRunStarter } from '../../packages/core-commands/src/index.ts';
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

/** The product's starter for this worker, listing each run it started. */
export function starter(workerActorId: string): Starter {
  const runs: RunRequest[] = [];
  const real = occurrenceRunStarter(workerActorId);
  return {
    runs,
    async start(tx, run) {
      const answer = await real(tx, run);
      if (typeof answer === 'string') runs.push(run);
      return answer;
    },
  };
}

/** What an occurrence's run writes, counted in every business. */
export interface RunFootprint {
  readonly runs: number;
  readonly pins: number;
  readonly tasks: number;
  readonly audit: number;
}

export async function runFootprint(w: AutomationWorld): Promise<RunFootprint> {
  return {
    runs: await w.count(
      'select count(*) as n from public.planned_runs where origin_occurrence_id is not null',
    ),
    pins: await w.count(
      `select count(*) as n from public.run_definition_pins where ref_kind = 'definition_version'`,
    ),
    tasks: await w.count(
      `select count(*) as n from public.records where data->>'source' = 'system:automation'`,
    ),
    audit: await w.count(
      `select count(*) as n from public.audit_events where command = 'occurrence.run_start'`,
    ),
  };
}

/** Bravo's own automation in `mode`, released, activated and approved by bravo's admin. */
export async function bravoApproved(
  w: AutomationWorld,
  mode: 'scheduled' | 'event',
): Promise<string> {
  return await w.db.app.withBusiness(w.bravo, async (tx) => {
    const actorId = w.bravoAdmin.actorId;
    const definitionId = await insertDefinition(tx, {
      kind: 'automation',
      name: 'Bravo digest',
      actorId,
    });
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
    return activation.id;
  });
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
