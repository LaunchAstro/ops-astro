// SPDX-License-Identifier: AGPL-3.0-only
//
// The click-through seed's runs (SR-1), each on a task `click-through-work.mjs`
// has just made. `w` is that file's world: the cast, and its calls as the
// admin (`as(w.admin, ...)`) and as the seeded agent (`asAgent`).

import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { raiseBudgetWait } from '../../packages/core-custody/src/broker-wait.ts';
import { spentOn } from '../../packages/core-runtime/src/budget-stop.ts';
import { sweepExpiredLeases } from '../../packages/core-runtime/src/recovery/sweep.ts';

/** A plain step, and the product's synthetic effect a launched run dispatches. */
const COMPOSE = { kind: 'compose', payload: { tone: 'plain' } };
const EFFECT = { kind: 'synthetic_comment', payload: {} };
/** Below one call's priced maximum, so the run stops at its ceiling. */
const SMALL_CEILING = 400;

/** A purpose of its own: an agent holds one live delegation per purpose. */
function purpose(w) {
  w.purposes += 1;
  return `click_through_${String(Date.now())}_${String(w.purposes)}`;
}

/** Proposed by the admin, approved by her, and picked up by the agent. */
async function working(w, id, step = COMPOSE, ceiling = 2_000) {
  const proposal = await w.as(w.admin, {
    command: 'task.propose',
    recordId: id,
    expectedRevision: await w.revision(id),
    purpose: purpose(w),
    maximumMinor: ceiling,
    currency: 'AUD',
    payload: { instruction: 'a made-up piece of work for the click-through' },
    step,
  });
  const approved = await approve(w, proposal.gateId, proposal.versionId);
  return await w.asAgent(undefined, {
    command: 'task.pickup',
    reservationId: approved.reservationId,
  });
}

function approve(w, gateId, versionId) {
  return w.as(w.admin, {
    command: 'task.decide',
    gateId,
    versionId,
    decision: 'approve',
    note: 'approved for the click-through',
  });
}

/** The worker's handback; with a successor, its output as the next version for review. */
function handBack(w, picked, successor) {
  const asked =
    successor === null
      ? {}
      : {
          successor: {
            purpose: purpose(w),
            maximumMinor: 2_000,
            currency: 'AUD',
            payload: { change: 'the made-up output for review' },
            step: successor,
          },
        };
  return w.asAgent(picked.credential, {
    command: 'task.handback',
    leaseId: picked.leaseId,
    fence: picked.fence,
    outcome: 'completed',
    report: { summary: 'a made-up draft, done' },
    actualMinor: null,
    ...asked,
  });
}

/** Version 1 approved, the worker's version 2 waiting for a person. */
export async function reviewWaiting(w, id) {
  await handBack(w, await working(w, id), EFFECT);
}

/**
 * Stopped at its ceiling as the broker stops it (`stopAtCeiling`), under the
 * run, lease and reservation held locked: the run waits for a person.
 */
export async function stopAtCap(w, id) {
  const picked = await working(w, id, COMPOSE, SMALL_CEILING);
  await w.database.withBusiness(w.cast.businessId, async (tx) => {
    const [held] = await tx.query(
      `select l.run_id, l.delegation_id, r.id as reservation_id, r.version_id,
              r.held_minor::text as held
         from public.planned_runs run
         join public.leases l on l.business_id = run.business_id and l.run_id = run.id
         join public.reservations r on r.business_id = l.business_id and r.id = l.reservation_id
        where l.business_id = $1 and l.id = $2
          for update of run, l, r`,
      [tx.businessId, picked.leaseId],
    );
    await raiseBudgetWait(tx, {
      runId: held.run_id,
      leaseId: picked.leaseId,
      delegationId: held.delegation_id,
      reservationId: held.reservation_id,
      versionId: held.version_id,
      ceilingMinor: Number(held.held),
      spentMinor: (await spentOn(tx, held.reservation_id)).spent,
    });
  });
}

/** The reviewed output approved and launched on a short lease, its effect dispatched. */
export async function dispatched(w, id) {
  const output = await handBack(w, await working(w, id, EFFECT), EFFECT);
  const launch = await approve(w, output.successorGateId, output.successorVersionId);
  const picked = await w.asAgent(undefined, {
    command: 'task.pickup',
    reservationId: launch.reservationId,
    leaseSeconds: 3,
  });
  await w.asAgent(picked.credential, {
    command: 'task.dispatch',
    leaseId: picked.leaseId,
    fence: picked.fence,
  });
  return picked;
}

/** The worker is gone: its lease runs out and the sweep leaves the outcome to a person. */
export async function sweepLost(w) {
  await wait(3_500);
  await w.database.withBusiness(w.cast.businessId, (tx) => sweepExpiredLeases(tx));
}

/** The agent hands reading the task to a helper agent of the business. */
export async function handToHelper(w, id) {
  const picked = await working(w, id);
  await w.asAgent(picked.credential, {
    command: 'run.delegate_child',
    leaseId: picked.leaseId,
    fence: picked.fence,
    helperActorId: await ensureHelper(w),
    purpose: 'click_through_helper',
    collections: ['task'],
    actions: ['read'],
    expiresInSeconds: 3_600,
  });
}

/** The helper agent: an actor and a login, found by the login's fixed subject. */
async function ensureHelper(w) {
  const subject = `click-through-helper-${w.cast.businessId}`;
  return await w.database.withBusiness(w.cast.businessId, async (tx) => {
    const [held] = await tx.query(
      `select al.actor_id from public.actor_logins al join public.logins l on l.id = al.login_id
        where al.business_id = $1 and l.subject = $2`,
      [tx.businessId, subject],
    );
    if (held !== undefined) return held.actor_id;
    const [actorId, loginId] = [randomUUID(), randomUUID()];
    await tx.query(
      `insert into public.actors (business_id, id, kind, active) values ($1, $2, 'agent', true)`,
      [tx.businessId, actorId],
    );
    await tx.query(
      `insert into public.logins (business_id, id, provider, subject) values ($1,$2,'supabase',$3)`,
      [tx.businessId, loginId, subject],
    );
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [tx.businessId, randomUUID(), loginId, actorId, w.cast.adminActorId],
    );
    return actorId;
  });
}

/** Finished work: approved, picked up and handed back completed. */
export async function finished(w, id) {
  await handBack(w, await working(w, id), null);
}
