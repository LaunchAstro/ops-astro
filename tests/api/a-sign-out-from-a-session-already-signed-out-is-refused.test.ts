// SPDX-License-Identifier: AGPL-3.0-only
//
// C58, a stale sign-out: a person signs out of a session, and that session's
// bearer then asks to sign out again. The second is refused as the door
// refuses any ended session (`AUTH_SESSION_EXPIRED`) and ends nothing more
// here; a refused sign-out still asks the provider to sign that token out,
// which is idempotent (`account-routes.ts`). The person's other session is
// still served. The world is `c58-sessions-world.ts`.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import {
  endedCount,
  EXPIRED,
  forgetSeen,
  OK,
  seen,
  served,
  sessions,
  tokenFor,
  useSessionsWorld,
  world,
} from './c58-sessions-world.ts';

useSessionsWorld();

describe.skipIf(serverUrl === undefined)('C58 a stale sign-out', () => {
  it('C58 sign out: a sign-out from a session already signed out is refused and ends nothing more', async () => {
    const kept = await tokenFor(world.mia.subject, randomUUID());
    const gone = await tokenFor(world.mia.subject, randomUUID());
    for (const token of [kept, gone]) {
      // oxlint-disable-next-line no-await-in-loop
      expect(await served(token)).toEqual(OK);
    }
    expect((await sessions('sign-out', gone)).body).toEqual({
      ended: 1,
      signedOutAtProvider: true,
    });
    forgetSeen();
    const endedOnce = await endedCount();

    const stale = await sessions('sign-out', gone);
    expect({ status: stale.status, code: stale.code }).toEqual(EXPIRED);
    expect(await endedCount()).toBe(endedOnce);
    expect(seen).toEqual([{ route: 'POST /logout?scope=local', authorization: `Bearer ${gone}` }]);
    expect(await served(gone)).toEqual(EXPIRED);
    expect(await served(kept)).toEqual(OK);
  });
});
