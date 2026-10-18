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
import {
  admitBeforeSignIns,
  guardMadeUp,
  productionSigns,
  type OwnerQuery,
} from '../../scripts/ops/made-up-only.ts';
import { createEmptyDatabase } from '../support/fresh-database.ts';
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
    keepsTheListUnderARefresh();
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

/** An owner connection that runs `wait` after the first statement starting with `prefix`. */
function pausing(admin: OwnerQuery, prefix: string, wait: () => Promise<void>): OwnerQuery {
  let paused = false;
  return {
    async execute<Row>(sql: string, parameters?: readonly unknown[]) {
      const rows = await admin.execute<Row>(sql, parameters);
      if (!paused && sql.startsWith(prefix)) {
        paused = true;
        await wait();
      }
      return rows;
    },
  };
}

function keepsTheListUnderARefresh(): void {
  it('a guard refresh while the list is rewritten keeps the sign-in restriction', async () => {
    const db = await createEmptyDatabase({ part: 'signinrace' });
    try {
      await db.admin.execute('create schema auth');
      await db.admin.execute('create table auth.users (id uuid primary key, email text)');
      expect(await admitBeforeSignIns(db.admin, true, ['ada@alpha.local'])).toEqual([]);
      let rewritten!: () => void;
      let read!: () => void;
      let finished!: () => void;
      const afterRewrite = new Promise<void>((resolve) => {
        rewritten = resolve;
      });
      const afterRead = new Promise<void>((resolve) => {
        read = resolve;
      });
      const afterFinish = new Promise<void>((resolve) => {
        finished = resolve;
      });
      // The installer stops right after its first write to the list, until the
      // refresh has read the list; the refresh installs only after it.
      const installing = pausing(db.admin, 'delete from ops_astro_made_up.sign_ins', async () => {
        rewritten();
        await afterRead;
      });
      const refreshing = pausing(
        db.admin,
        'select digest from ops_astro_made_up.sign_ins',
        async () => {
          read();
          await afterFinish;
        },
      );
      const install = guardMadeUp(installing, ['ada@alpha.local']);
      await afterRewrite;
      const refresh = guardMadeUp(refreshing);
      await install;
      finished();
      await refresh;
      await db.admin.execute('insert into auth.users (id, email) values ($1, $2)', [
        randomUUID(),
        `shared-account.${randomUUID().slice(0, 8)}@company.local`,
      ]);
      expect(await productionSigns(db.admin)).not.toEqual([]);
    } finally {
      await db.drop();
    }
  }, 600_000);
}
