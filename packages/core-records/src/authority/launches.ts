// SPDX-License-Identifier: AGPL-3.0-only
//
// Launch from the task: a person opens a run for the task's agent, waiting for
// the runner (migration 20261011102109). Assigning starts nothing; this does.
//
// The run's authority is a fresh delegation minted here, the person-side mint
// #1192 asked for: scoped to the one task, drawing on the launcher's own live
// grants (`mintDelegation` refuses what they do not hold), for
// `LAUNCH_HOURS`. Its purpose word names the task, so one agent may run on
// several tasks at once while the index still allows it one live delegation
// per task. The credential is not handed to the launcher: it is derived from
// the key, so the runner, signed in as the agent, is given it.
//
// The caller holds the task's lock, so two Launches of one task run one after
// the other and the second sees the first. The partial index is the backstop.
// An open launch whose delegation lapsed, or was revoked or settled, is ended
// here, and a new one opens; a live one refuses.

import { randomUUID } from 'node:crypto';
import { refuseCommand, type CommandRefusal } from '../register.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import { mintDelegation } from './delegations.ts';

/** How long a launch's delegation lives: the runner takes it, and works, inside it. */
export const LAUNCH_HOURS = 8;

export interface LaunchRequest {
  readonly taskId: string;
  readonly agentActorId: string;
  /** The person who clicked Launch, and their acting identity. */
  readonly personId: string;
  readonly actorId: string;
}

export type LaunchResult =
  | { readonly ok: true; readonly launchId: string }
  | { readonly ok: false; readonly refusal: CommandRefusal };

/** The purpose word of a launch's delegation: the task's, so it is never shared between tasks. */
export const launchPurpose = (taskId: string): string =>
  `launch_${taskId.toLowerCase().replaceAll('-', '')}`;

/**
 * The task's open launch, under its row lock: a refusal while its delegation
 * stands, else ended here so a fresh one may open. None, undefined.
 */
async function closeLapsed(tx: TenantQuery, taskId: string): Promise<CommandRefusal | undefined> {
  const open = await tx.query<{ readonly id: string; readonly live: boolean }>(
    `select l.id, (d.revoked_at is null and d.settled_at is null
                   and d.expires_at > clock_timestamp()) as live
       from public.task_launches l
       join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
      where l.business_id = $1 and l.task_id = $2 and l.state <> 'ended'
      for update of l`,
    [tx.businessId, taskId],
  );
  const held = open[0];
  if (held === undefined) return undefined;
  if (held.live) {
    return refuseCommand(
      'RUN_ALREADY_OPEN',
      [],
      [
        'A run of this task is already open, so it was not launched again.',
        'Wait for it to finish, or stop it, then launch again.',
      ],
    );
  }
  await tx.query(
    `update public.task_launches set state = 'ended', ended_at = clock_timestamp()
      where business_id = $1 and id = $2`,
    [tx.businessId, held.id],
  );
  return undefined;
}

export async function launchRun(tx: TenantQuery, request: LaunchRequest): Promise<LaunchResult> {
  const open = await closeLapsed(tx, request.taskId);
  if (open !== undefined) return { ok: false, refusal: open };
  const minted = await mintDelegation(tx, {
    agentActorId: request.agentActorId,
    delegatePersonId: request.personId,
    mintedByActorId: request.actorId,
    purpose: launchPurpose(request.taskId),
    collections: ['task'],
    actions: ['read', 'comment', 'write'],
    purposeScope: { kind: 'record', id: request.taskId },
    expiresAt: new Date(Date.now() + LAUNCH_HOURS * 3_600_000),
  });
  if (!minted.ok) return { ok: false, refusal: minted.refusal };
  const launchId = randomUUID();
  await tx.query(
    `insert into public.task_launches
       (business_id, id, task_id, agent_actor_id, delegation_id, launched_by_actor_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      tx.businessId,
      launchId,
      request.taskId,
      request.agentActorId,
      minted.value.delegation.id,
      request.actorId,
    ],
  );
  return { ok: true, launchId };
}
