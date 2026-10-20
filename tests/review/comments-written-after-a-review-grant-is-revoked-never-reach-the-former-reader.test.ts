// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- Sol's proof, one revocation read top to bottom */
//
// Sol's proof for S2237-2 (PR #2237, round 1), kept as Sol wrote it but for this header and the
// database guard: a client comment written after the reader's review and task read grants are
// revoked, between the covered review query and the comment query, never reaches them.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { randomUUID } from 'node:crypto';
import { c35xWorld, openedOf, type C35XWorld } from './c35-x-world.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { grantTo, shareWithClient } from '../commands/fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: C35XWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35xWorld('sol2237');
}, 120_000);
afterAll(async () => {
  if (w !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('the client Reviews read under revocation', () => {
  it('Sol proof, criterion 2: comments written after review grant revocation never reach the former reader', async () => {
    openedOf(detailOf(await w.open(w.fay)));
    const reader = await shareWithClient(w.world.db.app, w.world.business, w.admin, w.taskA);
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, reader, 'read', { kind: 'party', id: w.partyA }, false, 'review');
    });
    let crossed = false;
    const marker = 'sol-client-comment-created-after-revocation';
    // The fixture's pool has one connection. The competing writer needs its own pool.
    const writer = connect(w.world.db.appUrl);
    const database: Database = {
      log: w.world.db.app.log,
      close: async () => {},
      withBusiness: async (business, run) =>
        await w.world.db.app.withBusiness(business, async (tx) => {
          return await run({
            ...tx,
            query: async (sql, params) => {
              const rows = await tx.query(sql, params);
              // Pause after the covered review query, before any comments are read. Neither the
              // grant mutation nor the comment exists in that query's statement snapshot.
              if (
                !crossed &&
                sql.includes('as revision_ids') &&
                sql.includes('from public.reviews c')
              ) {
                crossed = true;
                const revoked = await w.world.db.admin.execute(
                  `update public.grants set revoked_at = clock_timestamp()
              where business_id = $1 and subject_id = $2 and collection in ('review', 'task')
                and action = 'read' and revoked_at is null returning id`,
                  [w.world.business, reader.personId],
                );
                expect(revoked).toHaveLength(2);
                const [task] = await w.world.db.admin.execute<{ revision: string }>(
                  'select revision::text as revision from public.records where business_id = $1 and id = $2',
                  [w.world.business, w.taskA],
                );
                const posted = await executeCommand(
                  writer,
                  w.world.business,
                  w.ava.presented,
                  'api',
                  {
                    command: 'task.comment',
                    operationId: randomUUID(),
                    recordId: w.taskA,
                    expectedRevision: Number(task?.revision),
                    audience: 'client',
                    body: marker,
                  } as never,
                );
                expect(codeOf(posted)).toBe('not-a-refusal');
              }
              return rows as never;
            },
          });
        }),
    };
    try {
      const answer = await executeRead(database, w.world.business, reader.presented, {
        read: 'review.client_list',
      } as never);
      expect(crossed).toBe(true);
      expect(JSON.stringify(answer)).not.toContain(marker);
    } finally {
      await writer.close();
    }
  });
});
