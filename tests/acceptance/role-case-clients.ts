// SPDX-License-Identifier: AGPL-3.0-only
//
// T4a's clients in the role-case matrix's world (T4e, REV185B2): in each of the
// two businesses a lead holding T4a's first role (R1, B1), two tasks and two
// clients, each shown one task by T4a's own `client`, one record grant each.
// T4-N2 runs the matrix on this world, so its client-to-client case crosses
// between two clients of one business as well as between the businesses.

import { enrol, grantTo } from '../commands/fixture.ts';
import { ROLE_GRANTS, client, create, type Tenant } from '../fixture/cast.ts';
import { tokenFor } from './cast.ts';
import type { World } from './world.ts';

export interface FixtureClient {
  readonly name: string;
  readonly businessKey: 'alpha' | 'bravo';
  readonly token: string;
  /** The one task shared with this client. */
  readonly task: string;
}

/* eslint-disable no-await-in-loop -- `issueGrant` reads the granter's own rows */
export async function seedFixtureClients(world: World): Promise<readonly FixtureClient[]> {
  const clients: FixtureClient[] = [];
  for (const [key, id] of [
    ['alpha', world.alpha],
    ['bravo', world.bravo],
  ] as const) {
    const lead = await enrol(world.db.app, id, key === 'alpha' ? 'R1' : 'B1');
    await world.db.app.withBusiness(id, async (tx) => {
      for (const action of ROLE_GRANTS[0] ?? []) await grantTo(tx, lead, action, undefined, true);
    });
    const tenant: Tenant = { id, key, members: [lead], lead, people: [lead.personId] };
    for (const n of [1, 2]) {
      const task = await create(world.db, tenant, `${key} client ${String(n)}'s task`);
      const presented = await client(world.db, tenant, n, task);
      const token = await tokenFor(presented.subject);
      clients.push({ name: `${key}-client-${String(n)}`, businessKey: key, token, task });
    }
  }
  return clients;
}
