// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2011): a review is opened on a task for one of its holder's bound pages, and each
// open of the same page adds the next revision, numbered from one and digested. The read
// lists both, in number order, with the review's task, holder and page.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { ABOUT, PAGE, c35World, type C35World } from './c35-world.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 open: DATABASE_URL is unset, so nothing below ran.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35open');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/** The backend a one-connection pool runs its statements on. */
const backendOf = async (db: Database): Promise<number> =>
  (
    await db.withBusiness(
      w.world.business,
      async (tx) => await tx.query<{ pid: number }>('select pg_backend_pid() as pid'),
    )
  )[0]!.pid;

/** Until both `pids` wait on `blocker`, each inside its open's transaction. */
async function bothWaitOn(blocker: number, pids: readonly number[]): Promise<boolean> {
  for (let i = 0; i < 400; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one probe at a time, each read after the last
    const [row] = await w.world.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and pid = any($2::int[])
          and $1::int = any(pg_blocking_pids(pid))`,
      [blocker, pids],
    );
    if (row?.n === pids.length) return true;
    // oxlint-disable-next-line no-await-in-loop -- one probe at a time, each read after the last
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return false;
}

/**
 * Two opens of `page`, each on a connection of its own, both parked behind the bound page's row
 * held on a third until both wait, so the two transactions overlap in Postgres rather than
 * queueing on the world's one-connection pool. Answers each open, its backend, and whether both
 * were seen waiting at once.
 */
async function opensAtOnce(page: Readonly<Record<string, string>>) {
  const own = [connect(w.world.db.appUrl, { max: 1 }), connect(w.world.db.appUrl, { max: 1 })];
  const holder = connect(w.world.db.appUrl);
  try {
    const pids = await Promise.all(own.map(async (db) => await backendOf(db)));
    let racing: Promise<CommandResult[]> | undefined;
    const waited = await holder.withBusiness(w.world.business, async (tx) => {
      await tx.query(
        `select 1 from public.party_site_pages
          where business_id = $1 and page_url = $2 and path = $3 for update`,
        [tx.businessId, page['pageUrl'], page['path']],
      );
      const [held] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
      racing = Promise.all(
        own.map(
          async (db) =>
            await executeCommand(db, w.world.business, w.ava.presented, 'api', {
              operationId: randomUUID(),
              command: 'review.open',
              sourceRevision: `rev-${randomUUID().slice(0, 8)}`,
              ...page,
            } as never),
        ),
      );
      return await bothWaitOn(held!.pid, pids);
    });
    return { both: await racing!, pids, waited };
  } finally {
    await Promise.all([...own, holder].map(async (db) => await db.close()));
  }
}

describe.skipIf(serverUrl === undefined)('C35 review records', () => {
  it('C35 a review opens on a task and numbers its revisions', async () => {
    const first = await w.open(w.ava, { sourceRevision: 'rev-1' });
    const second = await w.open(w.ava, { sourceRevision: 'rev-2' });
    expect([codeOf(first), codeOf(second)]).toStrictEqual(['not-a-refusal', 'not-a-refusal']);
    const [one, two] = [detailOf(first), detailOf(second)];
    expect(two['reviewId']).toBe(one['reviewId']);
    expect([one['number'], two['number']]).toStrictEqual([1, 2]);
    expect(one['digest']).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(two['digest']).not.toBe(one['digest']);

    expect(await w.read(w.ava, one['reviewId'])).toStrictEqual({
      ok: true,
      review: {
        reviewId: one['reviewId'],
        taskId: w.taskA,
        partyId: w.partyA,
        kind: 'page',
        pageUrl: PAGE,
        path: ABOUT,
        revisions: [
          { revisionId: one['revisionId'], number: 1, digest: one['digest'], captures: [] },
          { revisionId: two['revisionId'], number: 2, digest: two['digest'], captures: [] },
        ],
        // The latest beside the one before it, no pins yet (#2012) and none to carry (#2075).
        after: { revisionId: two['revisionId'], number: 2, digest: two['digest'], captures: [] },
        before: { revisionId: one['revisionId'], number: 1, digest: one['digest'], captures: [] },
        pins: [],
        carried: [],
        carryDue: false,
      },
    });
    expect(await w.count('reviews', w.world.business)).toBe(1);
    expect(await w.count('review_revisions', w.world.business)).toBe(2);
  });

  it('C35 two opens of one page at once land as revisions one and two of one review', async () => {
    const page = {
      taskId: w.taskB,
      pageUrl: 'https://client-b.example/team/',
      path: 'src/pages/team.md',
    };
    const { both, pids, waited } = await opensAtOnce(page);
    expect(waited, 'both opens wait inside their transactions').toBe(true);
    expect(new Set(pids).size, 'two opens on two backends').toBe(2);
    expect(both.map((one) => codeOf(one))).toStrictEqual(['not-a-refusal', 'not-a-refusal']);
    const details = both.map((one) => detailOf(one));
    expect(details[0]?.['reviewId']).toBe(details[1]?.['reviewId']);
    expect(details.map((detail) => detail['number']).toSorted()).toStrictEqual([1, 2]);
  }, 60_000);
});
