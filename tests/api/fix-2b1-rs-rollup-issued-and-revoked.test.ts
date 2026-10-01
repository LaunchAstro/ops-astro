// SPDX-License-Identifier: AGPL-3.0-only
//
// FIX-2B1 review RS, proof 2: `readRollup` now takes the grant fingerprint
// again after compute and holds the answer only when it did not move. A grant
// issued and revoked while one compute runs leaves the fingerprint the same
// before and after (the effective set is the same ids again), yet compute's
// own READ COMMITTED query saw the grant live. The wider answer is held under
// the narrow key, and the next call inside the lifetime, with that grant
// revoked, meets it: REVIEW-MAIN-2B1-5's consequence, through the window the
// fix leaves. rollup.ts's header says such an answer "is served once and never
// held". Same fixture as tests/api/review-main-2b1-5-rollup-race.test.ts.

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

if (serverUrl === undefined) console.warn('api/fix-2b1-rs-rollup: DATABASE_URL is unset.');
let s: Schedules;
let other: Database;
let alpha: Party;

/** The tasks the viewer holds task:read on; `around` runs once, before and after the first query. */
const readableAround = (around: {
  before: () => Promise<void>;
  after: () => Promise<void>;
}): Rollup<string[]> => {
  let first = true;
  return {
    name: 'fixture.readable-tasks',
    async compute(tx: TenantQuery, session) {
      const once = first;
      first = false;
      if (once) await around.before();
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
      if (once) await around.after();
      return rows.map((row) => row.id);
    },
  };
};

describe.skipIf(serverUrl === undefined)('FIX-2B1 RS proof 2: rollup grant issued and revoked in one compute', () => {
  beforeAll(async () => {
    s = await openSchedules('fx2b1rs2', 1_000_000);
    other = connect(s.db.appUrl, { source: 'racer' });
    alpha = await cq8World(s).party(`rs2-${randomUUID().slice(0, 8)}`);
  }, 180_000);

  afterAll(async () => {
    await other?.close();
    await s?.db.drop();
  });

  it('FIX-2B1-RS-2: a grant issued and revoked while compute runs does not leave the wider answer held under the unchanged fingerprint', async () => {
    const cache = createRollupCache({ lifetimeMs: 60_000, capacity: 100, now: () => 0 });
    const [a1, a2] = tasksOf(alpha);
    const viewer: Member = await enrol(s.db.app, alpha.id, `rs2-${randomUUID().slice(0, 8)}`);
    await s.db.app.withBusiness(alpha.id, async (tx) => {
      await grantTo(tx, viewer, 'read', { kind: 'record', id: a1 }, true);
    });

    let wide: string | undefined;
    const rollup = readableAround({
      before: async () => {
        wide = await other.withBusiness(alpha.id, async (tx) => await grantTo(tx, viewer, 'read'));
      },
      after: async () => {
        await other.withBusiness(alpha.id, async (tx) => await revokeGrant(tx, wide ?? ''));
      },
    });

    const racing = await readRollup(s.db.app, alpha.id, viewer.presented, rollup, cache);
    if (isCommandRefusal(racing)) throw new Error(`rollup refused ${racing.code}`);
    // The race happened: compute saw the business-wide grant (setup check).
    expect(racing).toEqual(expect.arrayContaining([a1, a2]));

    // Same clock, inside the lifetime: the grant is revoked, the viewer holds a1 alone.
    const after = await readRollup(s.db.app, alpha.id, viewer.presented, rollup, cache);
    if (isCommandRefusal(after)) throw new Error(`rollup refused ${after.code}`);
    expect(after, 'a revoked grant met the wider answer held under the unchanged fingerprint').toEqual([a1]);
  });
});
