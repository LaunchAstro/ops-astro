// SPDX-License-Identifier: AGPL-3.0-only
//
// U89 (#2038), Sol round 1 on #2126 (coverage): completions that race, each in
// a transaction on a connection of its own, parked behind the media review's
// row lock held on a third until both wait, so they overlap in Postgres
// rather than queueing on one pool. Two uploads become revisions one and two;
// one upload completed twice becomes one revision, the other refused; a review
// grant revoked while both wait leaves no revision.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, type C35World } from './c35-world.ts';
import { mediaStoreDouble, type MediaStoreDouble } from './media-store-double.ts';
import { coveringOf, mediaCalls, renderOf, writerOf, type MediaCalls } from './media-world.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { completeMediaUpload, type Database } from '../../packages/core-records/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C73 completion race: DATABASE_URL is unset, so nothing below ran.');

let w: C35World;
let store: MediaStoreDouble;
let media: MediaCalls;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35World('c73race');
  store = mediaStoreDouble();
  media = mediaCalls(w, store);
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const BODY = new Uint8Array([4, 3, 2, 1]);

/** A started upload with every part sent: its asset and its review. */
async function sentUpload(): Promise<{ readonly assetId: string; readonly reviewId: string }> {
  const started = await media.start(w.ava, w.taskA, renderOf(BODY));
  if ('code' in started) throw new Error(`start refused ${started.code}`);
  const parts = await media.parts(w.ava, started.assetId, 4);
  if ('code' in parts) throw new Error(`parts refused ${parts.code}`);
  media.send(parts.signed, BODY);
  return started;
}

const backendOf = async (db: Database): Promise<number> =>
  (
    await db.withBusiness(
      w.world.business,
      async (tx) => await tx.query<{ pid: number }>('select pg_backend_pid() as pid'),
    )
  )[0]!.pid;

/**
 * Until every one of `pids` waits, each on `blocker` or on another of `pids`: Postgres queues a
 * second waiter for a row behind the first, so only the first names the holder directly.
 */
async function allWaitOn(blocker: number, pids: readonly number[]): Promise<boolean> {
  for (let i = 0; i < 400; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one probe at a time, each read after the last
    const [row] = await w.world.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and pid = any($2::int[])
          and cardinality(pg_blocking_pids(pid)) > 0
          and pg_blocking_pids(pid) <@ ($2::int[] || $1::int)`,
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
 * Completes each of `assetIds` on a connection of its own while a third holds the review's row,
 * runs `whileWaiting` once all wait, then lets them go. Answers each completion and whether all
 * were seen waiting at once.
 */
async function completeAtOnce(
  reviewId: string,
  assetIds: readonly string[],
  whileWaiting: () => Promise<void> = async () => {},
) {
  const own = assetIds.map(() => connect(w.world.db.appUrl, { max: 1 }));
  const holder = connect(w.world.db.appUrl);
  try {
    const pids = await Promise.all(own.map(async (db) => await backendOf(db)));
    let racing: Promise<unknown[]> | undefined;
    const waited = await holder.withBusiness(w.world.business, async (tx) => {
      await tx.query('select 1 from public.reviews where business_id = $1 and id = $2 for update', [
        tx.businessId,
        reviewId,
      ]);
      const [held] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
      racing = Promise.all(
        own.map(
          async (db, index) =>
            await db.withBusiness(
              w.world.business,
              async (racer) =>
                await completeMediaUpload(
                  racer,
                  {
                    assetId: assetIds[index]!,
                    covering: coveringOf(w.ava),
                    writer: writerOf(w.ava),
                  },
                  store,
                ),
            ),
        ),
      );
      const all = await allWaitOn(held!.pid, pids);
      if (all) await whileWaiting();
      return all;
    });
    return { answers: await racing!, waited };
  } finally {
    await Promise.all([...own, holder].map(async (db) => await db.close()));
  }
}

const revisionNumbers = async (): Promise<number[]> =>
  (await media.rows('review_revisions', w.world.business)).map((row) => Number(row['number']));

describe.skipIf(serverUrl === undefined)('C73 completions at once', () => {
  it('two uploads completed at once become revisions one and two', async () => {
    const a = await sentUpload();
    const b = await sentUpload();
    const { answers, waited } = await completeAtOnce(a.reviewId, [a.assetId, b.assetId]);
    expect(waited).toBe(true);
    expect(
      answers.map((answer) => (answer as { number?: number }).number).toSorted(),
    ).toStrictEqual([1, 2]);
    expect(await revisionNumbers()).toStrictEqual([1, 2]);
  });

  it('one upload completed twice at once becomes one revision', async () => {
    const c = await sentUpload();
    const { answers, waited } = await completeAtOnce(c.reviewId, [c.assetId, c.assetId]);
    expect(waited).toBe(true);
    const codes = answers.map((answer) => (answer as { code?: string }).code ?? 'completed');
    expect(codes.toSorted()).toStrictEqual(['UPLOAD_NOT_OPEN', 'completed']);
    expect(await revisionNumbers()).toStrictEqual([1, 2, 3]);
  });

  it('a review grant revoked while completions wait leaves no revision', async () => {
    const d = await sentUpload();
    const e = await sentUpload();
    const { answers, waited } = await completeAtOnce(
      d.reviewId,
      [d.assetId, e.assetId],
      async () => {
        await w.world.db.admin.execute(
          `update public.grants set revoked_at = now()
          where business_id = $1 and subject_id = any($2::uuid[]) and collection = 'review'
            and revoked_at is null`,
          [w.world.business, [w.ava.personId, w.ava.actorId]],
        );
      },
    );
    expect(waited).toBe(true);
    expect(answers).toStrictEqual([{ code: 'NOT_FOUND' }, { code: 'NOT_FOUND' }]);
    expect(await revisionNumbers()).toStrictEqual([1, 2, 3]);
    const states = (await media.rows('review_media_assets', w.world.business))
      .filter((row) => row['id'] === d.assetId || row['id'] === e.assetId)
      .map((row) => row['state']);
    expect(states).toStrictEqual(['started', 'started']);
  });
});
