// SPDX-License-Identifier: AGPL-3.0-only
//
// SR-1: the click-through seed's helper keeps its read for the hour it asks,
// not the fifteen minutes a pickup's default lease would leave it, and a rerun
// whose waiting review has expired refuses that item by name rather than
// reporting it seeded (an expired gate waits for no one: `gate.pending` drops
// it).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  openCast,
  runSeed,
  SEED,
  serverUrl,
  taskId,
  type Cast,
} from './click-through-seed.fixture.ts';

let cast: Cast;

describe.skipIf(serverUrl === undefined)('SR-1 click-through seed helper and rerun', () => {
  beforeAll(async () => {
    cast = await openCast('sr1clickhelper');
    const seeded = runSeed(SEED, { admin: cast.db, local: cast.local });
    expect(seeded.status, seeded.out).toBe(0);
  }, 600_000);

  afterAll(async () => {
    await closeWorld(cast);
  });

  it("gives the helper's read the hour it asks for", async () => {
    const [child] = await cast.db.admin.execute<{ left: number }>(
      `select extract(epoch from child.expires_at - clock_timestamp())::float8 as left
         from public.delegations child
         join public.leases l on l.delegation_id = child.parent_delegation_id
         join public.planned_runs r on r.id = l.run_id
        where r.task_id = $1`,
      [await taskId(cast, 'Collect quotes for printing')],
    );
    expect(
      child?.left,
      'the helper read ends with the default fifteen-minute lease',
    ).toBeGreaterThan(50 * 60);
  });

  it('refuses a rerun whose waiting review has expired, naming the item', async () => {
    // As the application, as a person's write is: the made-up guard notes an owner's.
    const id = await taskId(cast, 'Revise the brochure copy');
    const expired = await cast.db.app.withBusiness(cast.business, (tx) =>
      tx.query(
        `update public.gates g set expires_at = clock_timestamp() - interval '1 minute'
           from public.planned_runs run
          where g.business_id = run.business_id and g.run_id = run.id and run.task_id = $1
            and g.state = 'pending' returning g.id`,
        [id],
      ),
    );
    expect(expired).toHaveLength(1);
    const again = runSeed(SEED, { admin: cast.db, local: cast.local });
    expect(again.status, `an expired review read as waiting: ${again.out}`).toBe(1);
    expect(again.out).toMatch(/'Revise the brochure copy'/u);
  }, 300_000);
});
