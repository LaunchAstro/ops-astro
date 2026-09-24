// SPDX-License-Identifier: AGPL-3.0-only
//
// FR1-JSONB #25 (final review round 1): a person comment on a trashed task,
// sent with the revision the caller read before the trash.
//
// The trash bumps the revision, so the person path compared the stale
// revision first and answered `VERSION_STALE` naming the trashed task's
// current revision, which told the caller the task exists. A trashed task is
// answered as a missing one on both entries (OWNER-CARD section 6; API.md,
// the trashed-board rule), whatever revision the comment carries.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './role-case-harness.ts';
import { serverUrl, type Answer } from './world.ts';

const bytesOf = (answer: Answer) => ({ status: answer.status, body: answer.body });

describe.skipIf(serverUrl === undefined)('FR1-JSONB #25: a comment on a trashed task', () => {
  let harness: Harness;
  let taskId: string;

  const revisionOf = async (recordId: string): Promise<number> => {
    const rows = await harness.world.db.app.withBusiness(harness.world.alpha, (tx) =>
      tx.query<{ readonly revision: string }>(
        `select revision::text as revision from records where id = $1`,
        [recordId],
      ),
    );
    return Number(rows[0]?.revision ?? 1);
  };

  const commentsSaying = async (body: string): Promise<number> => {
    const rows = await harness.world.db.app.withBusiness(harness.world.alpha, (tx) =>
      tx.query<{ readonly n: string }>(
        `select count(*)::text as n from records
          where record_type_id = $1 and data ->> 'task' = $2 and data ->> 'body' = $3`,
        [harness.world.spineAlpha.taskCommentTypeId, taskId, body],
      ),
    );
    return Number(rows[0]?.n);
  };

  const comment = async (recordId: string, expectedRevision: number, body: string) =>
    await harness.asPerson('task.comment', {
      recordId,
      expectedRevision,
      body,
      audience: 'internal',
    });

  beforeAll(async () => {
    harness = await createHarness('fr1_jsonb_comment');
    const { subject } = await harness.approvedReservation();
    taskId = subject.id;
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('answers the pre-trash revision NOT_FOUND, in the bytes of a missing task', async () => {
    const preTrash = await revisionOf(taskId);
    const trashed = await harness.asPerson('task.trash', {
      recordId: taskId,
      expectedRevision: preTrash,
    });
    expect(trashed.code, 'the trash').toBe('ok');
    expect(await revisionOf(taskId)).toBeGreaterThan(preTrash);

    const missing = await comment(randomUUID(), preTrash, 'on nothing');
    const stale = await comment(taskId, preTrash, 'stale on trash');
    console.log(`trashed task, pre-trash revision: ${stale.status} ${stale.code}`);

    expect(bytesOf(stale)).toStrictEqual(bytesOf(missing));
    expect(await commentsSaying('stale on trash')).toBe(0);
  });
});
