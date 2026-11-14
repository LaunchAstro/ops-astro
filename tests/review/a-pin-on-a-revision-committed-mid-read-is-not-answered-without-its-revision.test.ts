// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one read, interleaved top to bottom */
//
// #2404 (from #2114's review thread): the team review read reads the review's revisions,
// then its pins, in statements of their own under read committed. A revision and a pin on
// it committed between those two statements must not come back as a pin whose revision
// the answer does not hold: every pin answered names a revision in the same answer.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { ABOUT, c35World, PAGE, spot, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: C35World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('read2404');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const MARKER = 'pin-on-a-revision-committed-between-the-two-reads';

interface Answered {
  readonly revisions: readonly { readonly revisionId: string }[];
  readonly pins: readonly { readonly anchor: { readonly source: string } }[];
}

describe.skipIf(serverUrl === undefined)('the team review read between its statements', () => {
  it('a pin on a revision committed mid-read is not answered without its revision', async () => {
    const first = detailOf(await w.open(w.ava, { taskId: w.taskA }));
    expect(codeOf(await w.capture(w.ava, first['revisionId']))).toBe('not-a-refusal');
    expect(codeOf(await w.pin(w.ava, first['revisionId']))).toBe('not-a-refusal');
    let crossed = false;
    let later = '';
    // The fixture's pool has one connection, held by the read; the writer needs its own.
    const writer = connect(w.world.db.appUrl);
    const send = async (body: Record<string, unknown>) =>
      await executeCommand(writer, w.world.business, w.ava.presented, 'api', {
        operationId: randomUUID(),
        ...body,
      } as never);
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
                // After the revisions are read, before the pins are: a next revision, its
                // capture asked and a pin on it, each committed on its own connection.
                if (
                  !crossed &&
                  sql.includes('select id, number, digest from public.review_revisions')
                ) {
                  crossed = true;
                  const opened = await send({
                    command: 'review.open',
                    taskId: w.taskA,
                    pageUrl: PAGE,
                    path: ABOUT,
                    sourceRevision: `rev-${randomUUID().slice(0, 8)}`,
                  });
                  later = String(detailOf(opened)['revisionId']);
                  expect(detailOf(opened)['reviewId']).toBe(first['reviewId']);
                  expect(codeOf(await send({ command: 'review.capture', revisionId: later }))).toBe(
                    'not-a-refusal',
                  );
                  const pinned = await send({
                    command: 'review.pin_comment',
                    revisionId: later,
                    width: 1480,
                    selector: [spot()],
                    body: MARKER,
                    audience: 'internal',
                  });
                  expect(codeOf(pinned)).toBe('not-a-refusal');
                }
                return rows as never;
              },
            }),
        ),
    };
    try {
      const answer = await executeRead(database, w.world.business, w.ava.presented, {
        read: 'review.read',
        reviewId: first['reviewId'],
      } as never);
      expect(crossed).toBe(true);
      if (!('review' in answer)) throw new Error(`review.read refused: ${JSON.stringify(answer)}`);
      const review = answer.review as unknown as Answered;
      const held = new Set(review.revisions.map((revision) => revision.revisionId));
      expect({
        revisions: [...held],
        orphans: review.pins.filter((pin) => !held.has(pin.anchor.source)).length,
        pins: review.pins.length,
        leaked: JSON.stringify(answer).includes(MARKER),
      }).toEqual({ revisions: [first['revisionId']], orphans: 0, pins: 1, leaked: false });
      // The next read holds both revisions and both pins.
      const after = await w.read(w.ava, String(first['reviewId']));
      expect(JSON.stringify(after)).toContain(later);
      expect(JSON.stringify(after)).toContain(MARKER);
    } finally {
      await writer.close();
    }
  });
});
