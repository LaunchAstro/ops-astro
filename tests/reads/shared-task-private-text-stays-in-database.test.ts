// SPDX-License-Identifier: AGPL-3.0-only
//
// A reader outside the business, holding a read share on one task, is served
// the task's shared fields and its client comments. The private fields and the
// internal comments are not cut from the answer after the fact: they never
// leave Postgres. Every row any statement of the read returns is recorded and
// searched for the private markers.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { createTask } from '../tasks/fixture.ts';
import { enrol, grantTo, installSpine, shareWithClient, type Member } from '../commands/fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { writeComment } from '../../packages/core-records/src/tasks/comments.ts';
import type {
  BusinessId,
  Database,
  TransactionQuery,
} from '../../packages/core-records/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();

const SLOTTED = `private-lane-${randomUUID()}`;
const UNSLOTTED = `private-description-${randomUUID()}`;
const INTERNAL = `internal-note-${randomUUID()}`;
const TITLE = `shared-title-${randomUUID()}`;
const CLIENT = `client-message-${randomUUID()}`;
const SOURCE = `client-comment-source-${randomUUID()}`;

let db: FreshDatabase;
let alpha: BusinessId;
let outsider: Member;
let task: string;

/** The read as `outsider`, with every row each statement returned. */
async function observedRead() {
  const received: string[] = [];
  const observed: Database = {
    log: db.app.log,
    close: async () => {},
    withBusiness: async (businessId, run) =>
      await db.app.withBusiness(businessId, async (tx) => {
        const watched: TransactionQuery = {
          businessId: tx.businessId,
          savepoint: tx.savepoint,
          async query<Row>(statement: string, parameters?: readonly unknown[]) {
            const rows = await tx.query<Row>(statement, parameters);
            received.push(JSON.stringify(rows));
            return rows;
          },
        };
        return await run(watched);
      }),
  };
  const answer = await executeRead(observed, alpha, outsider.presented, {
    read: 'task.read',
    recordId: task,
  });
  return { answer: JSON.stringify(answer), received: received.join('\n') };
}

/** One task with a marker in each private place, shared with one outsider. */
async function seed(): Promise<void> {
  db = await createFreshDatabase({ part: 'sharedtext' });
  alpha = (await insertBusiness(db.app, 'alpha')) as BusinessId;
  const spine = await installSpine(db.app, alpha);
  const ada = await enrol(db.app, alpha, 'ada');
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, ada, 'read');
    await grantTo(tx, ada, 'share');
    task = await createTask(tx, spine, { title: TITLE, parentId: null });
    await tx.query(
      `update public.records
          set data = data || jsonb_build_object('lane', $3::text, 'description', $4::text)
        where business_id = $1 and id = $2`,
      [tx.businessId, task, SLOTTED, UNSLOTTED],
    );
    for (const [audience, body] of [
      ['internal', INTERNAL],
      ['client', CLIENT],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await writeComment(tx, spine.taskCommentTypeId, {
        taskId: task,
        authorActorId: ada.actorId,
        commentType: audience === 'client' ? 'client' : 'note',
        audience,
        body,
        source: audience === 'client' ? SOURCE : 'app',
      });
    }
  });
  outsider = await shareWithClient(db.app, alpha, ada, task);
  // The markers are where the read could reach them: the lane in its slot.
  const [row] = await db.admin.execute<{ readonly txt_6: string | null }>(
    `select txt_6 from public.records where id = $1`,
    [task],
  );
  expect(row?.txt_6).toBe(SLOTTED);
}

describe.skipIf(serverUrl === undefined)('a shared task read from outside the business', () => {
  beforeAll(seed, 180_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('serves the shared title and the client comment, and no private value reaches the process', async () => {
    const { answer, received } = await observedRead();
    expect(answer).toContain(TITLE);
    expect(answer).toContain(CLIENT);
    for (const [what, marker] of [
      ['a private slotted field', SLOTTED],
      ['a private unslotted field', UNSLOTTED],
      ['an internal comment', INTERNAL],
      ["a client comment's private field", SOURCE],
    ] as const) {
      expect.soft(answer, `${what} reached the answer`).not.toContain(marker);
      expect.soft(received, `${what} was returned to the serving process`).not.toContain(marker);
    }
  });
});
