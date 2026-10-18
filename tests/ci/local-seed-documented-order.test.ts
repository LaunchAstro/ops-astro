// SPDX-License-Identifier: AGPL-3.0-only
//
// #1780: the local slice starts in the order docs/local/README.md gives, and
// the made-up guard still refuses what that order did not write. The start
// command is read from the README's "Start it" block, so the order tested is
// the order documented, and each step runs as its package script says.
//
// The seed's own steps run as real processes from a scratch copy of the
// checkout, so every `.local/` file lands there. The container steps cannot
// run here, so each stands in as narrowly as it can: `db:up` and `db:migrate`
// are the harness's fresh, migrated database; `auth:up` makes the schema
// auth-up.sh makes and the `auth.users` table GoTrue's own migration makes;
// and the identity service is a loopback stand-in that writes a sign-in row
// for each login it is asked to create, as GoTrue does.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { businessRow, serverUrl } from './staging-no-production-data.fixture.ts';
import {
  closeWorld,
  failed,
  keys,
  mark,
  openWorld,
  startAsDocumented,
  type World,
} from './local-seed-documented-order.fixture.ts';

let world: World | undefined;

afterEach(async () => {
  if (world !== undefined) await closeWorld(world);
  world = undefined;
});

describe.skipIf(serverUrl === undefined)('the local seed in the documented order', () => {
  seedsInOrder();
  refusesWhatTheOrderDidNotWrite();
});

function seedsInOrder() {
  it('a fresh made-up stack seeds in the documented order, and again on a second run', async () => {
    world = await openWorld();
    const first = await startAsDocumented(world);
    expect(failed(first)?.out ?? '').toBe('');
    expect(first.map((step) => step.script)).toContain('db:seed');
    expect(await keys(world)).toEqual(['alpha', 'bravo']);
    expect(await mark(world)).toMatch(/^ops-astro made-up data; /u);

    const second = await startAsDocumented(world);
    expect(failed(second)?.out ?? '').toBe('');
    expect(await keys(world)).toEqual(['alpha', 'bravo']);
  }, 600_000);

  it('a sign-in that is not a made-up address, written before auth:seed, is refused by the guard and named', async () => {
    world = await openWorld();
    const w = world;
    const planted = `harbour.freight.${randomUUID().slice(0, 8)}@example.com`;
    const ran = await startAsDocumented(w, {
      'auth:seed': () =>
        w.db!.admin.execute('insert into auth.users (id, email) values ($1, $2)', [
          randomUUID(),
          planted,
        ]),
    });
    const refused = failed(ran);
    expect(refused?.script).toBe('db:seed');
    expect(refused?.out).toMatch(
      /REFUSED, not provably made-up data: it holds a sign-in that is not a made-up address/u,
    );
    expect(refused?.out).not.toContain(planted);
    expect(await keys(w)).toEqual([]);
  }, 600_000);
}

function refusesWhatTheOrderDidNotWrite() {
  it('a business the seed did not make, written before auth:seed, is refused by the guard and named', async () => {
    world = await openWorld();
    const w = world;
    const planted = `harbour-freight-${randomUUID().slice(0, 8)}`;
    const ran = await startAsDocumented(w, {
      'auth:seed': () => businessRow(w.db!.admin, planted),
    });
    const refused = failed(ran);
    expect(refused?.script).toBe('db:seed');
    expect(refused?.out).toMatch(
      /REFUSED, not provably made-up data: it holds a business the seed did not make/u,
    );
    expect(refused?.out).not.toContain(planted);
    expect(await keys(w)).toEqual([planted]);
  }, 600_000);

  it('a database that held a sign-in before the guard stood is refused at the admission and left unmarked', async () => {
    world = await openWorld();
    const w = world;
    const planted = `kept.${randomUUID().slice(0, 8)}@alpha.local`;
    const ran = await startAsDocumented(w, {
      'db:admit': () =>
        w.db!.admin.execute('insert into auth.users (id, email) values ($1, $2)', [
          randomUUID(),
          planted,
        ]),
    });
    const refused = failed(ran);
    expect(refused?.script).toBe('db:admit');
    expect(refused?.out).toMatch(
      /REFUSED, not provably made-up data: it carries no made-up mark and is not a new database/u,
    );
    expect(refused?.out).not.toContain(planted);
    expect(await mark(w)).toBeNull();
    expect(await keys(w)).toEqual([]);
  }, 600_000);
}
