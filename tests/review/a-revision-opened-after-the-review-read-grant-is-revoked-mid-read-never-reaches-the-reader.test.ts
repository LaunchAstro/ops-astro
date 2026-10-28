// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2061), Sol's proof for S2061-1: the team review read checks its grant in the covered
// review query, then reads the review's revisions and captures in statements of their own. A
// reader's sole `review:read` grant revoked between them, and a revision opened after the
// revocation, never reaches the former reader: the read is refused as one the grant does not cover.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { ABOUT, PAGE, c35World, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: C35World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('sol2061read');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('the team review read under revocation', () => {
  it('a revision opened after the review read grant is revoked mid-read never reaches the reader', async () => {
    const opened = detailOf(await w.open(w.ava, { taskId: w.taskA }));
    expect(codeOf(await w.capture(w.ava, opened['revisionId']))).toBe('not-a-refusal');
    let crossed = false;
    let later = '';
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
                // After the covered review query, before the revisions are read: neither the
                // revocation nor the new revision is in that statement's snapshot.
                if (!crossed && sql.includes('select c.task_id, c.party_id, c.kind')) {
                  crossed = true;
                  const revoked = await w.world.db.admin.execute(
                    `update public.grants set revoked_at = clock_timestamp()
                      where business_id = $1 and subject_id = $2 and collection = 'review'
                        and action = 'read' and revoked_at is null returning id`,
                    [w.world.business, w.ava.personId],
                  );
                  expect(revoked).toHaveLength(1);
                  const reopened = await executeCommand(
                    writer,
                    w.world.business,
                    w.ava.presented,
                    'api',
                    {
                      command: 'review.open',
                      operationId: randomUUID(),
                      taskId: w.taskA,
                      pageUrl: PAGE,
                      path: ABOUT,
                      sourceRevision: 'after-the-revocation',
                    } as never,
                  );
                  later = String(detailOf(reopened)['revisionId']);
                }
                return rows as never;
              },
            }),
        ),
    };
    try {
      const answer = await executeRead(database, w.world.business, w.ava.presented, {
        read: 'review.read',
        reviewId: opened['reviewId'],
      } as never);
      expect(crossed).toBe(true);
      expect(later).toMatch(/^[0-9a-f-]{36}$/);
      expect({
        code: codeOf(answer as never),
        leaked: JSON.stringify(answer).includes(later),
      }).toEqual({
        code: 'NOT_FOUND',
        leaked: false,
      });
    } finally {
      await writer.close();
    }
  });
});
