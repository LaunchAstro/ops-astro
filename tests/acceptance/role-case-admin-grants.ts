// SPDX-License-Identifier: AGPL-3.0-only
//
// The matrix's grant read, moved whole from `role-case-harness.ts` to keep that
// file under the line limit: what each caller holds, read back from the rows,
// and the admin topped up to every (collection, action) pair the surface
// declares, through the real `issueGrant`, with what was added printed.

import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { issueGrant, type Action } from '../../packages/core-records/src/authority/grants.ts';
import type { Caller, World } from './world.ts';
import { pairFor } from './role-case-harness-shape.ts';

/** Each caller's held `collection:action` pairs, by name, after the admin's top-up. */
export async function heldByWithAdminTopUp(
  world: World,
): Promise<Map<string, ReadonlySet<string>>> {
  const needed = new Map(COMMAND_SURFACE.map((one) => [pairFor(one), one]));
  const heldBy = new Map<string, ReadonlySet<string>>();
  const added: string[] = [];

  await world.db.app.withBusiness(world.alpha, async (tx) => {
    // Read back rather than copied from the fixture's own list of actions: the
    // cases decide what to expect from what a person really holds, so a list
    // that drifted from the rows would quietly change what is proved.
    for (const caller of [world.ada, world.mia, world.noah] as readonly Caller[]) {
      // eslint-disable-next-line no-await-in-loop -- one caller at a time reads as a list
      const grants = await tx.query<{ readonly collection: string; readonly action: string }>(
        `select collection, action from public.grants
          where subject_kind = 'person' and subject_id = $1 and revoked_at is null`,
        [caller.personId],
      );
      heldBy.set(caller.name, new Set(grants.map((row) => `${row.collection}:${row.action}`)));
    }
    const adaHolds = heldBy.get('ada') as ReadonlySet<string>;
    for (const [pair, declaration] of needed) {
      if (adaHolds.has(pair)) continue;
      const [collection, action] = pair.split(':');
      // eslint-disable-next-line no-await-in-loop
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'person', id: world.ada.personId as string },
        scope: { kind: 'business', id: null },
        collection: collection as string,
        action: action as Action,
        parentGrantId: null,
        grantedByActorId: world.ada.actorId as string,
      });
      if (!issued.ok) throw new Error(`matrix: grant ${pair} refused ${issued.refusal.code}`);
      added.push(`${pair} (${declaration.name})`);
    }
    heldBy.set('ada', new Set(needed.keys()));
  });
  console.log(
    `matrix: admin grants the surface needs and the world does not seed: ${
      added.length === 0 ? 'none' : added.join(', ')
    }`,
  );
  return heldBy;
}
