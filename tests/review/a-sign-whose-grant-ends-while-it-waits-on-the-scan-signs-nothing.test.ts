// SPDX-License-Identifier: AGPL-3.0-only
//
// U89 (#2039, C73), Sol round 1 on #2484: a playback sign judges the caller's
// grant at the review's holder, then waits on the asset's row while a scan
// verdict is landing. A grant that ends during that wait covers nothing: the
// sign answers NOT_FOUND and the store is asked to sign nothing. The sign runs
// on a connection of its own while a second holds the scan's lock, so the
// wait is a real one in Postgres.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, type C35World } from './c35-world.ts';
import { mediaStoreDouble, type MediaStoreDouble } from './media-store-double.ts';
import { coveringOf, digestOf, mediaCalls, type MediaCalls } from './media-world.ts';
import { PNG_BYTES } from './media-fixtures.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { landMediaScan, signMediaRead } from '../../packages/core-records/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C73 sign after a wait: DATABASE_URL is unset, so nothing below ran.');

let w: C35World;
let store: MediaStoreDouble;
let media: MediaCalls;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35World('c73signwait');
  store = mediaStoreDouble(16);
  media = mediaCalls(w, store);
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const PNG_DECLARED = {
  kind: 'image',
  type: 'image/png',
  codec: null,
  byteCount: PNG_BYTES.byteLength,
  digest: digestOf(PNG_BYTES),
} as const;

/** Until `pid` waits on a lock another backend holds; false when it never does. */
async function waits(pid: number): Promise<boolean> {
  for (let i = 0; i < 400; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one probe at a time, each read after the last
    const [row] = await w.world.db.admin.execute<{ waiting: boolean }>(
      'select cardinality(pg_blocking_pids($1::int)) > 0 as waiting',
      [pid],
    );
    if (row?.waiting === true) return true;
    // oxlint-disable-next-line no-await-in-loop -- one probe at a time, each read after the last
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return false;
}

/** The reader's review:read grants end one second from now, by the database's clock. */
const endReadGrantsSoon = async (): Promise<void> => {
  await w.world.db.admin.execute(
    `update public.grants set expires_at = clock_timestamp() + interval '1 second'
      where business_id = $1 and collection = 'review' and action = 'read'
        and subject_id = any($2::uuid[]) and revoked_at is null`,
    [w.world.business, [w.ava.personId, w.ava.actorId]],
  );
};

/** Waits, on the database's clock, until every one of the reader's review:read grants has ended. */
const untilReadGrantsEnd = async (): Promise<boolean> => {
  await w.world.db.admin.execute('select pg_sleep(1.2)');
  const [row] = await w.world.db.admin.execute<{ ended: boolean }>(
    `select bool_and(expires_at < clock_timestamp()) as ended from public.grants
      where business_id = $1 and collection = 'review' and action = 'read'
        and subject_id = any($2::uuid[]) and revoked_at is null`,
    [w.world.business, [w.ava.personId, w.ava.actorId]],
  );
  return row?.ended === true;
};

describe.skipIf(serverUrl === undefined)('C73 a sign that waits on a landing scan', () => {
  it('C73 a grant that ends while the sign waits on the asset signs nothing', async () => {
    const held = await media.upload(w.ava, w.taskA, PNG_DECLARED, PNG_BYTES);
    if (!('reviewId' in held.completed)) throw new Error('the clean upload completed');
    const scanner = connect(w.world.db.appUrl, { max: 1 });
    const signer = connect(w.world.db.appUrl, { max: 1 });
    try {
      const [backend] = await signer.withBusiness(
        w.world.business,
        async (tx) => await tx.query<{ pid: number }>('select pg_backend_pid() as pid'),
      );
      if (backend === undefined) throw new Error('the signer names its backend');
      let signing: ReturnType<typeof signMediaRead> | undefined;
      const seen = await scanner.withBusiness(w.world.business, async (tx) => {
        await landMediaScan(
          tx,
          { assetId: held.assetId, engine: 'test-engine', verdict: 'passed' },
          store,
        );
        await endReadGrantsSoon();
        signing = signer.withBusiness(
          w.world.business,
          async (racer) =>
            await signMediaRead(
              racer,
              { assetId: held.assetId, covering: coveringOf(w.ava, 'read'), lifeSeconds: 300 },
              store,
            ),
        );
        return { waited: await waits(backend.pid), ended: await untilReadGrantsEnd() };
      });
      expect(seen).toStrictEqual({ waited: true, ended: true });
      expect(await signing).toStrictEqual({ code: 'NOT_FOUND' });
      expect(store.calls).not.toContain('signRead');
    } finally {
      await Promise.all([scanner.close(), signer.close()]);
    }
  });
});
