// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-MAIN-2B1-5, red proof. `readRollup` takes the viewer's grant
// fingerprint and then runs `compute` as two statements of one READ COMMITTED
// transaction. A grant issued and committed on another connection between them
// is seen by `compute` and not by the fingerprint, so the wider answer is held
// under the narrower fingerprint F0. Once that grant is revoked the fingerprint
// is F0 again, and the viewer meets the wider answer until the lifetime ends;
// the file header promises a revoked grant "misses the cache rather than
// meeting a wider answer". The fixture rollup below commits the grant on a
// second connection at the start of its first compute, before its own query.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  revokeGrant,
  TASK_TYPE_KEY,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import {
  createRollupCache,
  isCommandRefusal,
  readRollup,
  type Rollup,
} from '../../packages/core-commands/src/index.ts';
import { EFFECTIVE } from '../../packages/core-records/src/authority/grants.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { openSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { cq8World, type Party } from '../runtime/cq-8-world.ts';
import { tasksOf } from './c4-change-support.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) console.warn('api/review-main-2b1-5: DATABASE_URL is unset.');
let s: Schedules;
let other: Database;
let alpha: Party;

/** The tasks the viewer holds task:read on; `beforeQuery` runs once, ahead of the first query. */
const readableWith = (beforeQuery: () => Promise<void>): Rollup<string[]> => {
  let first = true;
  return {
    name: 'fixture.readable-tasks',
    async compute(tx: TenantQuery, session) {
      if (first) {
        first = false;
        await beforeQuery();
      }
      const rows = await tx.query<{ id: string }>(
        `${EFFECTIVE},
           mine as (select e.scope_kind, e.scope_id from effective e
                     where e.collection = 'task' and e.action = 'read'
                       and ((e.subject_kind = 'person' and e.subject_id = $1)
                            or (e.subject_kind = 'actor' and e.subject_id = $2)))
         select r.id from public.records r
           join public.record_types t on t.business_id = r.business_id
            and t.id = r.record_type_id and t.key = $3
          where r.deleted_at is null
            and (exists (select 1 from mine where scope_kind = 'business')
                 or r.id in (select scope_id from mine where scope_kind = 'record'))
          order by r.id`,
        [session.personId, session.actorId, TASK_TYPE_KEY],
      );
      return rows.map((row) => row.id);
    },
  };
};

describe.skipIf(serverUrl === undefined)('REVIEW-MAIN-2B1-5 rollup fingerprint race', () => {
  beforeAll(async () => {
    s = await openSchedules('rm2b1p5', 1_000_000);
    other = connect(s.db.appUrl, { source: 'racer' });
    alpha = await cq8World(s).party(`rm5-${randomUUID().slice(0, 8)}`);
  }, 180_000);

  afterAll(async () => {
    await other?.close();
    await s?.db.drop();
  });

  it('REVIEW-MAIN-2B1-5: a grant committed between the fingerprint and compute, then revoked, must not leave the wider answer cached under the narrow fingerprint', async () => {
    const cache = createRollupCache({ lifetimeMs: 60_000, capacity: 100, now: () => 0 });
    const [a1, a2] = tasksOf(alpha);
    const viewer: Member = await enrol(s.db.app, alpha.id, `rm5-${randomUUID().slice(0, 8)}`);
    await s.db.app.withBusiness(alpha.id, async (tx) => {
      await grantTo(tx, viewer, 'read', { kind: 'record', id: a1 }, true);
    });

    // g2: business-wide task:read, issued and committed on a second connection
    // after the fingerprint was taken and before compute's own query.
    let wide: string | undefined;
    const rollup = readableWith(async () => {
      wide = await other.withBusiness(alpha.id, async (tx) => await grantTo(tx, viewer, 'read'));
    });

    const racing = await readRollup(s.db.app, alpha.id, viewer.presented, rollup, cache);
    if (isCommandRefusal(racing)) throw new Error(`rollup refused ${racing.code}`);
    expect(wide).toBeDefined();
    // The race happened: compute saw g2 (setup check, not the defect).
    expect(racing).toEqual(expect.arrayContaining([a1, a2]));

    await s.db.app.withBusiness(alpha.id, async (tx) => await revokeGrant(tx, wide ?? ''));

    // Same clock, inside the lifetime: with g2 revoked the viewer holds a1 alone.
    const after = await readRollup(s.db.app, alpha.id, viewer.presented, rollup, cache);
    if (isCommandRefusal(after)) throw new Error(`rollup refused ${after.code}`);
    expect(after, 'a revoked grant met the wider cached answer').toEqual([a1]);
  });
});
