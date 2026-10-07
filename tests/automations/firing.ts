// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A's firing helpers over C33's world: adopt a released version, claim,
// dispatch, revoke and turn off, each in the first business's own
// transaction. Starting the run is the agent engine's (AW-01 J), which C52-A
// does not wire, so dispatch is handed a starter that lists what it was asked
// to start and answers a run id of its own. Each dispatch runs on a connection
// of its own, as each worker will, so dispatches sent at once overlap (the app
// pool holds one).

import { expect } from 'vitest';
import { occurrenceRunStarter } from '../../packages/core-commands/src/index.ts';
import {
  adoptVersion,
  connect,
  dispatchOccurrence,
  insertActivation,
  insertDefinition,
  lockActivation,
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
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import { installSpine } from '../commands/fixture.ts';
import type { FreshDatabase } from '../support/fresh-database.ts';
import { insertWorker } from './run-start.ts';
import { DIGEST, type Approved, type AutomationWorld } from './world.ts';

export interface Starter {
  readonly runs: RunRequest[];
  readonly start: RunStarter;
}

const workers = new WeakMap<FreshDatabase, Map<string, Promise<string>>>();

/** A business's worker and task spine, made once per database. */
async function workerOf(db: FreshDatabase, business: string): Promise<string> {
  const made = workers.get(db) ?? new Map<string, Promise<string>>();
  workers.set(db, made);
  const known = made.get(business);
  if (known !== undefined) return await known;
  const making = installSpine(db.app, business).then(async () => await insertWorker(db, business));
  made.set(business, making);
  return await making;
}

/**
 * The product's run starter for each business's own worker, listing each run
 * it started: a dispatch names a real run (P11b's keys). A new starter first
 * hands back the runs earlier cases started, so C33's run ceiling holds none.
 */
export async function starter(db: FreshDatabase, ...businesses: string[]): Promise<Starter> {
  const runs: RunRequest[] = [];
  const own = new Map<string, RunStarter>();
  for (const business of businesses) {
    // eslint-disable-next-line no-await-in-loop -- one business after another
    own.set(business, occurrenceRunStarter(await workerOf(db, business)));
  }
  await db.admin.execute(
    `update public.planned_runs set state = 'handed_back'
      where business_id = any($1) and origin_occurrence_id is not null`,
    [businesses],
  );
  return {
    runs,
    async start(tx, run) {
      const real = own.get(tx.businessId);
      if (real === undefined) throw new Error(`no worker for ${tx.businessId}`);
      const answer = await real(tx, run);
      if (typeof answer === 'string') runs.push(run);
      return answer;
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
  /** Each dispatch sent while the owner holds the activation's row, let go once all wait on it. */
  dispatchedTogether(
    activationId: string,
    occurrenceIds: readonly string[],
    start: RunStarter,
  ): Promise<Dispatch[]>;
  revoke(approvalId: string): Promise<RevokeResult>;
  turnOff(activationId: string): Promise<void>;
  started(activationId: string): Promise<number>;
}

// eslint-disable-next-line max-lines-per-function -- the helpers share the world
export function firingOf(w: AutomationWorld): Firing {
  let hour = 0;
  const nextDue = (): Date => new Date(Date.UTC(2026, 10, 1, (hour += 1)));
  const dispatch = async (occurrenceId: string, start: RunStarter): Promise<Dispatch> => {
    const own = connect(w.db.appUrl);
    try {
      return await own.withBusiness(w.alpha, (tx) => dispatchOccurrence(tx, occurrenceId, start));
    } finally {
      await own.close();
    }
  };
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
    async dispatchedTogether(activationId, occurrenceIds, start) {
      const holder = connect(w.db.appUrl);
      const sent: Promise<Dispatch>[] = [];
      try {
        await holder.withBusiness(w.alpha, async (tx) => {
          await lockActivation(tx, activationId);
          sent.push(...occurrenceIds.map(async (id) => await dispatch(id, start)));
          await waitingOn(w, occurrenceIds.length);
        });
        return await Promise.all(sent);
      } finally {
        await holder.close();
      }
    },
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
