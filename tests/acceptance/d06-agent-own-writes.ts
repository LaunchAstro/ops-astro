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

/** The body for one of the agent's own writes, without its operation id; undefined for any other. */
export async function ownWriteBody(
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
