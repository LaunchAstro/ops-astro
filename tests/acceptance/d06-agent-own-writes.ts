// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive bodies for the writes an agent makes on its own task inside
// its delegation, for `d06-agent.test.ts`: an author's edit and delete of its
// own comment (MP-4-5), the three marks (MP-4-9), the Ad hoc mark (MP-4-10)
// and the brief through `task.update` (MP-4-7).
//
// A harness, not a suite: nothing here runs on its own.

import { randomUUID } from 'node:crypto';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import { mintDelegation } from '../../packages/core-records/src/index.ts';
import type { Harness } from './role-case-harness.ts';

/** What of the agent's pickup these bodies read. */
interface Held {
  readonly credential: string;
  readonly taskId: string;
}

/** A comment the agent writes on its own task, and the body that changes it (MP-4-5). */
async function ownCommentChange(
  harness: Harness,
  name: CommandName,
  held: Held,
): Promise<Record<string, unknown>> {
  const written = await harness.asAgent(
    'task.comment',
    { operationId: randomUUID(), recordId: held.taskId, body: 'to change', audience: 'internal' },
    held.credential,
  );
  const detail = written.body['detail'] as Record<string, unknown> | undefined;
  const words = name === 'task.edit_comment' ? { body: 'changed' } : {};
  return { recordId: held.taskId, commentId: detail?.['commentId'], ...words };
}

/**
 * The body for one of the agent's own writes, without its operation id, and
 * the credential it travels with; undefined for any other.
 */
export async function ownWriteBody(
  harness: Harness,
  name: CommandName,
  held: Held,
): Promise<{ body: Record<string, unknown>; credential: string } | undefined> {
  if (name === 'task.assign') return await ownAssign(harness, held);
  const body = await ownFieldBody(harness, name, held);
  return body === undefined ? undefined : { body, credential: held.credential };
}

async function ownFieldBody(
  harness: Harness,
  name: CommandName,
  held: Held,
): Promise<Record<string, unknown> | undefined> {
  if (name === 'task.edit_comment' || name === 'task.delete_comment') {
    return await ownCommentChange(harness, name, held);
  }
  if (name !== 'task.set_scores' && name !== 'task.set_adhoc' && name !== 'task.update') {
    return undefined;
  }
  // Read, not carried: each control moves the task's revision.
  const rows = await harness.world.db.admin.execute<{ readonly revision: string }>(
    `select revision::text as revision from public.records where id = $1`,
    [held.taskId],
  );
  const expectedRevision = Number(rows[0]?.revision ?? '0');
  const fields =
    name === 'task.set_scores'
      ? { impact: 5 }
      : name === 'task.set_adhoc'
        ? { ad_hoc: true }
        : { agent_brief: 'the agent’s brief' };
  return { recordId: held.taskId, expectedRevision, fields };
}

/** One delegation holding assign per picked-up task: a pickup mints read, comment and write only. */
const assigning = new Map<string, string>();

/**
 * The agent's `task.assign` on its own task (MP-4-8), under a delegation from
 * the person who approved the work that also holds assign; the pickup's own
 * credential is refused `DELEGATION_OUT_OF_PURPOSE` for it.
 */
async function ownAssign(
  harness: Harness,
  held: Held,
): Promise<{ body: Record<string, unknown>; credential: string }> {
  const { world } = harness;
  let credential = assigning.get(held.taskId);
  if (credential === undefined) {
    credential = await world.db.app.withBusiness(world.alpha, async (tx) => {
      const minted = await mintDelegation(tx, {
        agentActorId: world.agent.actorId,
        delegatePersonId: world.ada.personId as string,
        mintedByActorId: world.ada.actorId as string,
        purpose: `assign_${randomUUID().slice(0, 8)}`,
        collections: ['task'],
        actions: ['read', 'write', 'assign'],
        purposeScope: { kind: 'record', id: held.taskId },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      if (!minted.ok)
        throw new Error(`d06-agent: the assign mint was refused ${minted.refusal.code}`);
      return minted.value.credential;
    });
    assigning.set(held.taskId, credential);
  }
  const rows = await world.db.admin.execute<{ readonly revision: string }>(
    `select revision::text as revision from public.records where id = $1`,
    [held.taskId],
  );
  const expectedRevision = Number(rows[0]?.revision ?? '0');
  const fields = { assignee: world.ada.personId as string };
  return { body: { recordId: held.taskId, expectedRevision, fields }, credential };
}
