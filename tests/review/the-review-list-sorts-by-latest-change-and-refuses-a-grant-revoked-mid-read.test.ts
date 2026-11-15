// SPDX-License-Identifier: AGPL-3.0-only
//
// The Reviews page's read (`review.list`, #2157), Sol round 1 on #2487. The list is newest
// change first, and a pin or a change request is a change to its review, though neither
// writes the review's own row. And a caller whose only review:read grant is revoked after the
// read's first grant check, before its list statement, is refused as one holding the grant
// nowhere, never answered an empty list.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detailOf } from '../commands/agent-fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import type { TransactionQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { B_FILE, B_PAGE, c35World, type C35World } from './c35-world.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('revlistorder');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

type Answer = Readonly<Record<string, unknown>>;

const list = async (db: Database = w.world.db.app): Promise<Answer> =>
  (await executeRead(db, w.world.business, w.ava.presented, {
    read: 'review.list',
  } as never)) as unknown as Answer;

const order = (answer: Answer): readonly string[] =>
  ((answer['reviews'] ?? []) as readonly { readonly reviewId: string }[]).map((r) => r.reviewId);

/**
 * The app's database, whose read transaction revokes ava's review:read grants (on a connection
 * of its own, committed) once, right after the read's first grant check answers.
 */
const revokingAfterTheFirstCheck = (): Database => {
  const app = w.world.db.app;
  let revoked = false;
  const revoke = async (): Promise<void> => {
    revoked = true;
    await w.world.db.admin.execute(
      `update public.grants set revoked_at = clock_timestamp()
        where business_id = $1 and collection = 'review' and action = 'read'
          and subject_id = any($2::uuid[]) and revoked_at is null`,
      [w.world.business, [w.ava.personId, w.ava.actorId]],
    );
  };
  const watched = (tx: TransactionQuery): TransactionQuery =>
    ({
      ...tx,
      query: async (text: string, parameters?: readonly unknown[]) => {
        const rows = await tx.query(text, parameters);
        if (!revoked && text.includes('as held') && parameters?.[1] === 'read') await revoke();
        return rows;
      },
    }) as TransactionQuery;
  return {
    ...app,
    withBusiness: async (business, run, options) =>
      await app.withBusiness(business, async (tx) => await run(watched(tx)), options),
  } as Database;
};

describe.skipIf(serverUrl === undefined)('review.list order and a grant revoked mid-read', () => {
  it('lists the review whose pin is newest first, though the pin writes no review row', async () => {
    const a = detailOf(await w.open(w.ava));
    expect('refused' in (await w.capture(w.ava, a['revisionId']))).toBe(false);
    const b = detailOf(await w.open(w.dee, { taskId: w.taskB, pageUrl: B_PAGE, path: B_FILE }));
    expect(order(await list())).toStrictEqual([b['reviewId'], a['reviewId']]);

    const pinned = await w.pin(w.ava, String(a['revisionId']));
    expect('refused' in pinned).toBe(false);
    const answer = await list();
    expect(order(answer)).toStrictEqual([a['reviewId'], b['reviewId']]);
    expect((answer['reviews'] as readonly Answer[])[0]).toMatchObject({ openPins: 1 });
  });

  it('refuses a caller whose grant is revoked after the first check, never an empty list', async () => {
    const answer = await list(revokingAfterTheFirstCheck());
    expect(answer['code']).toBe('SCOPE_NOT_GRANTED');
    expect(answer['reviews']).toBeUndefined();
  });
});
