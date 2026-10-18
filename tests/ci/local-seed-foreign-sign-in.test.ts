// SPDX-License-Identifier: AGPL-3.0-only
//
// #1860: the made-up guard refuses a sign-in `auth:seed` did not write, even
// at a made-up `.local` address: one written before `auth:seed` runs, one at a
// seed address that `auth:seed` did not create, and one written between two
// documented runs. Proofs from Sol's review of #1853 at 51bbb5c, run on the
// documented-order harness (local-seed-documented-order.fixture.ts).

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { serverUrl } from './staging-no-production-data.fixture.ts';
import { productionSigns } from '../../scripts/ops/made-up-only.ts';
import {
  closeWorld,
  failed,
  keys,
  openWorld,
  startAsDocumented,
  type World,
} from './local-seed-documented-order.fixture.ts';

let world: World | undefined;
afterEach(async () => {
  if (world) await closeWorld(world);
  world = undefined;
});

describe.skipIf(serverUrl === undefined)(
  'the local seed refuses a sign-in auth:seed did not write',
  () => {
    refusedBeforeAuthSeed();
    refusedBetweenRuns();
    admitsTheSeedsOwn();
  },
);

function refusedBeforeAuthSeed(): void {
  it('a local-address sign-in written before auth:seed is refused at db:seed', async () => {
    world = await openWorld();
    const w = world;
    const ran = await startAsDocumented(w, {
      'auth:seed': () =>
        w.db!.admin.execute('insert into auth.users (id, email) values ($1, $2)', [
          randomUUID(),
          `shared-account.${randomUUID().slice(0, 8)}@company.local`,
        ]),
    });
    expect(failed(ran)?.script).toBe('db:seed');
    expect(await keys(w)).toEqual([]);
  }, 600_000);

  it('an owner-inserted sign-in at a seed address is foreign before auth:seed runs', async () => {
    world = await openWorld();
    const w = world;
    const plantedId = randomUUID();
    await startAsDocumented(w, {
      'auth:seed': async () => {
        await w.db!.admin.execute('insert into auth.users (id, email) values ($1, $2)', [
          plantedId,
          'ada@alpha.local',
        ]);
        // Asked before auth:seed runs: no duplicate address or identity-provider
        // behaviour is involved, and only the owner's row exists.
        expect(
          await w.db!.admin.execute('select id from auth.users where id = $1', [plantedId]),
        ).toHaveLength(1);
        expect(await productionSigns(w.db!.admin)).not.toEqual([]);
      },
    });
  }, 600_000);
}

function refusedBetweenRuns(): void {
  it('a local-address sign-in written between documented runs is refused at db:admit', async () => {
    world = await openWorld();
    const w = world;
    expect(failed(await startAsDocumented(w))).toBeUndefined();
    await w.db!.admin.execute('insert into auth.users (id, email) values ($1, $2)', [
      randomUUID(),
      `shared-account.${randomUUID().slice(0, 8)}@company.local`,
    ]);
    const ran = await startAsDocumented(w);
    expect(failed(ran)?.script).toBe('db:admit');
  }, 600_000);

  it('an owner-inserted person stays foreign after seeding', async () => {
    world = await openWorld();
    const w = world;
    expect(failed(await startAsDocumented(w))).toBeUndefined();
    const [business] = await w.db!.admin.execute<{ id: string }>(
      "select id from public.businesses where key = 'alpha'",
    );
    await w.db!.admin.execute(
      'insert into public.people (business_id, id, display_name) values ($1, $2, $3)',
      [business!.id, randomUUID(), 'An invented foreign person'],
    );
    expect(await productionSigns(w.db!.admin)).toContain('it holds a person the seed did not make');
  }, 600_000);
}

function admitsTheSeedsOwn(): void {
  it('a fresh documented seed leaves its own agent and external sign-ins admitted', async () => {
    world = await openWorld();
    const ran = await startAsDocumented(world);
    expect(
      failed(ran),
      JSON.stringify(ran.map(({ script, status }) => ({ script, status }))),
    ).toBeUndefined();
    // local-seed creates these itself after admission, through the identity service.
    const rows = await world.db!.admin.execute<{ email: string }>(
      'select email from auth.users order by email',
    );
    expect(rows.map((row) => row.email)).toEqual(
      expect.arrayContaining(
        ['agent@alpha', 'agent@bravo', 'ext@alpha'].map((at) => `${at}.local`),
      ),
    );
    expect(await productionSigns(world.db!.admin)).toEqual([]);
  }, 600_000);
}
