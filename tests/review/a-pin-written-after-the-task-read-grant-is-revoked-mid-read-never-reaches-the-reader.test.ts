// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- Sol's proof, one revocation read top to bottom */
//
// C35 (#2114), Sol's proof for S2114-3: `task.read` judges its grant once, before the task
// row, then reads the task's comments, pins among them, in statements of their own. A
// reader's sole `task:read` grant revoked after the task row, and a pin written after the
// revocation, never reaches the former reader: the read is refused as the next one is.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c35World, spot, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: C35World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('sol2114read');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const MARKER = 'sol-pin-written-after-the-task-read-grant-was-revoked';

describe.skipIf(serverUrl === undefined)('the task read under revocation', () => {
  it('a pin written after the task read grant is revoked mid-read never reaches the reader', async () => {
    const opened = detailOf(await w.open(w.ava, { taskId: w.taskA }));
    expect(codeOf(await w.capture(w.ava, opened['revisionId']))).toBe('not-a-refusal');
    let crossed = false;
    // The fixture's pool has one connection; the competing writer needs its own.
    const writer = connect(w.world.db.appUrl);
    const database: Database = {
      log: w.world.db.app.log,
      close: async () => {},
      withBusiness: async (business, run) =>
        await w.world.db.app.withBusiness(
          business,
          async (tx) =>
            await run({
              ...tx,
              query: async (sql, params) => {
                const rows = await tx.query(sql, params);
                // After the task row, before its comments are read: neither the revocation
                // nor the pin is in that statement's snapshot.
                if (!crossed && sql.includes('r.txt_4 as title') && sql.includes('r.id = $3')) {
                  crossed = true;
                  const revoked = await w.world.db.admin.execute(
                    `update public.grants set revoked_at = clock_timestamp()
                      where business_id = $1 and subject_id = $2 and collection = 'task'
                        and action = 'read' and revoked_at is null returning id`,
                    [w.world.business, w.ava.personId],
                  );
                  expect(revoked).toHaveLength(1);
                  const pinned = await executeCommand(
                    writer,
                    w.world.business,
                    w.ava.presented,
                    'api',
                    {
                      command: 'review.pin_comment',
                      operationId: randomUUID(),
                      revisionId: opened['revisionId'],
                      width: 1480,
                      selector: [spot()],
                      body: MARKER,
                      audience: 'internal',
                    } as never,
                  );
                  expect(codeOf(pinned)).toBe('not-a-refusal');
                }
                return rows as never;
              },
            }),
        ),
    };
    try {
      const answer = await executeRead(database, w.world.business, w.ava.presented, {
        read: 'task.read',
        recordId: w.taskA,
      } as never);
      const next = await executeRead(w.world.db.app, w.world.business, w.ava.presented, {
        read: 'task.read',
        recordId: w.taskA,
      } as never);
      expect(crossed).toBe(true);
      expect({
        code: codeOf(answer as never),
        leaked: JSON.stringify(answer).includes(MARKER),
        next: codeOf(next as never),
      }).toEqual({
        code: 'SCOPE_NOT_GRANTED',
        leaked: false,
        next: 'SCOPE_NOT_GRANTED',
      });
    } finally {
      await writer.close();
    }
  });
});
