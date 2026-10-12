// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import {
  approveLegalVersion,
  draftLegalVersion,
  publishLegalVersion,
  readPublishedLegal,
} from '../../packages/core-records/src/operations/legal-documents.ts';
import { insertActor, insertBusiness, insertPerson } from '../identity/fixture.ts';
import { createFreshDatabase, type FreshDatabase } from '../support/fresh-database.ts';
import { latch } from '../support/lock-wait-race.ts';

let db: FreshDatabase;
let first: Database;
let second: Database;
let business: string;
let actor: string;

beforeAll(async () => {
  db = await createFreshDatabase({ part: 'sol1360legal' });
  first = connect(db.appUrl);
  second = connect(db.appUrl);
  business = await insertBusiness(db.app, 'sol-legal-order');
  actor = await db.app.withBusiness(business, async (tx) =>
    insertActor(tx, await insertPerson(tx, 'operator')),
  );
}, 120000);

afterAll(async () => {
  await first?.close();
  await second?.close();
  await db?.drop();
});

// eslint-disable-next-line max-lines-per-function -- a proof kept as its reviewer wrote it
it('concurrent legal publications cannot leave the earlier visible version current after the later commit', async () => {
  const versions = await db.app.withBusiness(business, async (tx) => {
    const one = await draftLegalVersion(
      tx,
      { document: 'client-terms', version: '1.0', body: 'First terms.' },
      actor,
    );
    const two = await draftLegalVersion(
      tx,
      { document: 'client-terms', version: '2.0', body: 'Replacement terms.' },
      actor,
    );
    if (one === undefined || two === undefined) throw new Error('drafts missing');
    expect(await approveLegalVersion(tx, one.id, one.digest, actor)).toBeUndefined();
    expect(await approveLegalVersion(tx, two.id, two.digest, actor)).toBeUndefined();
    return { one, two };
  });
  const stamped = latch<number>();
  const commitFirst = latch();
  const one = first.withBusiness(business, async (tx) => {
    expect(await publishLegalVersion(tx, versions.one.id, actor)).toBeUndefined();
    const [me] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
    if (me === undefined) throw new Error('no backend');
    stamped.open(me.pid);
    await commitFirst.promise;
  });
  one.catch(() => null);
  const pid = await stamped.promise;
  let committedSecond = false;
  const two = second
    .withBusiness(business, (tx) => publishLegalVersion(tx, versions.two.id, actor))
    .then(() => {
      committedSecond = true;
      // oxlint-disable-next-line unicorn/no-useless-undefined -- kept as its reviewer wrote it
      return undefined;
    });
  two.catch(() => null);
  try {
    let blocked = false;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (committedSecond) break;
      // oxlint-disable-next-line no-await-in-loop -- observe this backend before polling again
      const [row] = await db.admin.execute<{ blocked: boolean }>(
        'select exists(select 1 from pg_stat_activity where datname = current_database() and $1::int = any(pg_blocking_pids(pid))) as blocked',
        [pid],
      );
      if (row?.blocked === true) {
        blocked = true;
        break;
      }
      // oxlint-disable-next-line no-await-in-loop -- polling waits between observations
      await delay(10);
    }
    expect(
      blocked || committedSecond,
      'second publication either commits or waits on the first',
    ).toBe(true);
    const visibleBefore = await db.app.withBusiness(business, (tx) =>
      readPublishedLegal(tx, 'client-terms'),
    );
    commitFirst.open();
    await one;
    await two;
    const current = await db.app.withBusiness(business, (tx) =>
      readPublishedLegal(tx, 'client-terms'),
    );
    expect({ visibleBefore: visibleBefore?.version, current: current?.version }).toEqual(
      blocked
        ? { visibleBefore: undefined, current: '2.0' }
        : { visibleBefore: '2.0', current: '1.0' },
    );
  } finally {
    commitFirst.open();
    await Promise.allSettled([one, two]);
  }
}, 30000);
