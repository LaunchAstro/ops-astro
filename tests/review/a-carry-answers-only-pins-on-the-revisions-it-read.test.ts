// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one carry, interleaved top to bottom */
//
// C35-X (#2075) beside #2404: the carry reads the review's revisions, then its pins, in
// statements of their own under read committed, and takes its pins from the revisions it
// read. A next revision and a pin on it committed between those statements are neither
// carried nor counted: the carry onto the second revision writes the first revision's pin
// alone. The revision committed mid-read is numbered after the one carried onto, so it
// could not be carried from in any case; this proof holds the carry to that answer.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { ABOUT, c35World, PAGE, spot, type C35World } from './c35-world.ts';
import {
  carriesOnto,
  carryUnder,
  landedReview,
  landPage,
  must,
  nextRevision,
  pinOn,
} from './c35-x-carry.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: C35World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('carry2404');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const SEEN = { text: 'Book a visit today. Our team.', document: 'a' };
const MARKER = 'pin-on-a-revision-committed-while-the-carry-read';
const REVISIONS = 'select id, number from public.review_revisions where business_id = $1';

describe.skipIf(serverUrl === undefined)('the carry between its statements', () => {
  it('a pin on a revision committed mid-carry is neither carried nor counted', async () => {
    const { reviewed, lease } = await landedReview(w, 'carry between its reads', SEEN);
    const pinned = await pinOn(w, reviewed.revisionId);
    const second = await nextRevision(w, reviewed);
    await landPage(w, lease, second, SEEN);

    let crossed = false;
    let later = '';
    // The fixture's pool has one connection, held by the carry; the writer needs its own.
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
                // After the carry reads the revisions, before it reads the pins: a next
                // revision, its capture asked and a pin on it, each committed on its own.
                if (!crossed && sql.includes(REVISIONS)) {
                  crossed = true;
                  const opened = await send({
                    command: 'review.open',
                    taskId: reviewed.taskId,
                    pageUrl: PAGE,
                    path: ABOUT,
                    sourceRevision: `rev-${randomUUID().slice(0, 8)}`,
                  });
                  later = String(detailOf(opened)['revisionId']);
                  expect(codeOf(await send({ command: 'review.capture', revisionId: later }))).toBe(
                    'not-a-refusal',
                  );
                  const marked = await send({
                    command: 'review.pin_comment',
                    revisionId: later,
                    width: 1480,
                    selector: [spot()],
                    body: MARKER,
                    audience: 'internal',
                  });
                  expect(codeOf(marked)).toBe('not-a-refusal');
                }
                return rows as never;
              },
            }),
        ),
    };
    try {
      const carried = await carryUnder(w, lease, second, database);
      expect(crossed).toBe(true);
      expect(later).not.toBe('');
      const answer = must(carried.result, 'review.carry_pins');
      expect({
        counted: Number(answer['moved']) + Number(answer['lost']),
        leaked: JSON.stringify(carried.result).includes(MARKER),
        rows: (await carriesOnto(w, second)).map((row) => row.comment_id),
        later: (await carriesOnto(w, later)).length,
      }).toStrictEqual({ counted: 1, leaked: false, rows: [pinned], later: 0 });
    } finally {
      await writer.close();
    }
  });
});
