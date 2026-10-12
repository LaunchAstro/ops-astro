// SPDX-License-Identifier: AGPL-3.0-only
//
// An access ending names the mapping it ended. One sign-in subject is a
// person's login in alpha and in bravo. A remap of bravo's login begins before
// bravo ends that person's access and commits its new live mapping after the
// ending: the login is live in bravo again, so alpha asking whether it is live
// elsewhere hears yes from both answers (the owner's read and the definer
// function), or alpha's provider ban would end bravo's live sign-in. The remap
// goes to another person or to an agent. Ending bravo's only mapping, with no
// remap, still reads not live.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  factorLoginLiveElsewhere,
  loginLiveElsewhere,
} from '../../packages/core-records/src/index.ts';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { insertActor, insertAgentActor, insertMembership, insertPerson } from './fixture.ts';
import { endInBravo, sharedSubject, type SharedSubject } from './live-elsewhere-world.ts';

const serverUrl = databaseUrlFromEnvironment();
let db: FreshDatabase;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'live_mapping' });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

type Execute = AdminConnection['execute'];

/**
 * Bravo's login is remapped by `remap` in a transaction that deactivates the
 * old mapping first, waits while bravo's ending commits, then writes the new
 * live mapping and commits after it.
 */
async function remappedAcrossTheEnding(
  pair: SharedSubject,
  remap: (execute: Execute, login: string) => Promise<void>,
): Promise<void> {
  const [row] = await db.admin.execute<{ readonly login_id: string }>(
    'select login_id from public.person_logins where id = $1',
    [pair.bravoMapping],
  );
  let begun!: () => void;
  const started = new Promise<void>((resolve) => {
    begun = resolve;
  });
  let ended!: () => void;
  const endingCommitted = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const remapping = db.admin.transaction(async (execute) => {
    await execute(
      `update public.person_logins set active = false, deactivated_at = now()
        where business_id = $1 and id = $2`,
      [pair.bravo, pair.bravoMapping],
    );
    begun();
    await endingCommitted;
    await remap(execute, row?.login_id ?? '');
  });
  await started;
  try {
    await endInBravo(db, pair);
  } finally {
    ended();
  }
  await remapping;
}

async function liveFromAlpha(pair: SharedSubject): Promise<readonly boolean[]> {
  return [
    await loginLiveElsewhere(db.admin, pair.subject, pair.alpha),
    await db.app.withBusiness(
      pair.alpha,
      async (tx) => await factorLoginLiveElsewhere(tx, pair.alphaLogin),
    ),
  ];
}

it.skipIf(serverUrl === undefined)(
  'a login remapped to another person across an ending in another business stays live there',
  async () => {
    const pair = await sharedSubject(db);
    const next = await db.app.withBusiness(pair.bravo, async (tx) => {
      const person = await insertPerson(tx, 'Takes the login over');
      await insertMembership(tx, person);
      return { person, actor: await insertActor(tx, person) };
    });
    await remappedAcrossTheEnding(pair, async (execute, login) => {
      await execute(
        `insert into public.person_logins (business_id, id, login_id, person_id, linked_by_actor_id)
         values ($1, $2, $3, $4, $5)`,
        [pair.bravo, randomUUID(), login, next.person, next.actor],
      );
    });
    expect(await liveFromAlpha(pair)).toEqual([true, true]);
  },
  60_000,
);

it.skipIf(serverUrl === undefined)(
  'a login remapped to an agent across an ending in another business stays live there',
  async () => {
    const pair = await sharedSubject(db);
    const agent = await db.app.withBusiness(pair.bravo, async (tx) => await insertAgentActor(tx));
    await remappedAcrossTheEnding(pair, async (execute, login) => {
      await execute(
        `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
         values ($1, $2, $3, $4, $4)`,
        [pair.bravo, randomUUID(), login, agent],
      );
    });
    expect(await liveFromAlpha(pair)).toEqual([true, true]);
  },
  60_000,
);

it.skipIf(serverUrl === undefined)(
  'a login whose only mapping in another business was ended there is not live there',
  async () => {
    const pair = await sharedSubject(db);
    expect(await liveFromAlpha(pair)).toEqual([true, true]);
    await endInBravo(db, pair);
    expect(await liveFromAlpha(pair)).toEqual([false, false]);
  },
  60_000,
);
