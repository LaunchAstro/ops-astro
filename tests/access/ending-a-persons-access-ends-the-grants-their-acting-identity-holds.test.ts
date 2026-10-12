// SPDX-License-Identifier: AGPL-3.0-only
//
// C58: `access.end` ends every live grant the person holds, and a grant can be
// given to the person's acting identity (an `actor` subject) as well as to the
// person. Each case gives one to the actor alone, ends the person's access,
// and reads that grant back: it is revoked with the person's own. The world is
// `../authority/c58-end-access-world.ts`.

import { describe, expect, it } from 'vitest';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { serverUrl } from '../acceptance/world.ts';
import { WHOLE_BUSINESS } from '../commands/fixture.ts';
import {
  apiWith,
  end,
  harness,
  outcome,
  scripted,
  stateOf,
  teammate,
  useEndAccessWorld,
} from '../authority/c58-end-access-world.ts';

useEndAccessWorld();

/** Whether the grant is still live, read past row security. */
const live = async (grantId: string): Promise<boolean> =>
  (
    await harness.world.db.admin.execute<{ readonly live: boolean }>(
      'select revoked_at is null as live from public.grants where id = $1',
      [grantId],
    )
  )[0]?.live ?? false;

describe.skipIf(serverUrl === undefined)("C58 end a person's access: their actor's grants", () => {
  it("C58 one act: a grant given to the person's acting identity ends with the person's own", async () => {
    const api = apiWith(scripted().provider);
    const { person } = await teammate('ida');
    const actorGrant = await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'actor', id: person.actorId },
        scope: WHOLE_BUSINESS,
        collection: 'task',
        action: 'read',
        canDelegate: false,
        parentGrantId: null,
        grantedByActorId: person.actorId,
      });
      if (!issued.ok) throw new Error(`the actor's grant was refused ${issued.refusal.code}`);
      return issued.value;
    });
    expect(await live(actorGrant), 'the actor holds a live grant').toBe(true);

    expect(outcome(await end(api, person.personId))).toEqual({ status: 200, code: 'ok' });

    expect(await live(actorGrant), "the actor's grant ended with the person").toBe(false);
    expect((await stateOf(person)).liveGrants).toBe(0);
  });
});
