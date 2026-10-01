// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, the gate before the first real client data, through the real API:
// a person an accepted invitation names, signed in with no second factor, is
// refused a read at the door with `AUTH_SECOND_FACTOR_SETUP_REQUIRED`, while
// the factor routes serve them; and an enrolment token, presented as a
// bearer or as the session cookie, opens no factor setup and asks the
// provider nothing. The accept itself is `c39-t-second-factor-first`'s.

import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cookieNameFor } from '../../apps/api/auth/session.ts';
import { CSRF_HEADER, SESSION_HEADER } from '../../packages/core-wire/src/index.ts';
import { bearer, call, personPath, serverUrl } from '../acceptance/world.ts';
import {
  api,
  clientB,
  forgetSeen,
  seen,
  served,
  tokenFor,
  useSessionsWorld,
  world,
} from './c58-sessions-world.ts';

useSessionsWorld();

const GATE = { status: 401, code: 'AUTH_SECOND_FACTOR_SETUP_REQUIRED' };

describe.skipIf(serverUrl === undefined)('C39-T second factor first, through the API', () => {
  it('C39-T second factor first: an invited person with no factor is refused content at the door and served the factor setup; an enrolment token opens neither', async () => {
    const mia = world.mia;
    expect(await served(await tokenFor(mia.subject, randomUUID()))).toEqual({
      status: 200,
      code: 'ok',
    });
    await world.db.admin.execute(
      `insert into public.invitations
         (business_id, id, person_id, role_key, address, state, expires_at, created_by_actor_id,
          ended_at)
       values ($1, $2, $3, 'member', 'mia@example.test', 'accepted', now() + interval '1 day', $4, now())`,
      [world.alpha, randomUUID(), mia.personId, world.ada.actorId],
    );

    const token = await tokenFor(mia.subject, randomUUID());
    expect(await served(token)).toEqual(GATE);
    // A login no invitation placed, with no factor, is served as before.
    const placed = await tokenFor(clientB.presented.subject, randomUUID());
    expect(await served(placed)).toEqual({ status: 200, code: 'ok' });

    // The enrolment token is not a session: no factor setup, nothing asked.
    forgetSeen();
    const link = randomBytes(32).toString('base64url');
    const path = personPath('alpha', '/account/factor/enrol');
    const tab = randomUUID();
    const cookie = {
      cookie: `${cookieNameFor(tab)}=${link}`,
      [SESSION_HEADER]: tab,
      [CSRF_HEADER]: '1',
    };
    for (const headers of [bearer(link), cookie]) {
      // oxlint-disable-next-line no-await-in-loop
      const refused = await call(api, path, { token: link }, headers);
      // Refused at the door, before any factor act: not a session (401) or not this site's (403).
      expect([401, 403], refused.code).toContain(refused.status);
      expect(refused.code).toMatch(/^AUTH_/u);
    }
    expect(seen).toEqual([]);

    // The person's own fresh sign-in reaches the factor setup through the gate.
    const enrolled = await call(api, path, {}, bearer(token));
    expect(enrolled.status).toBe(200);
    expect(seen.map((each) => each.route)).toEqual(['POST /factors']);
  });
});
