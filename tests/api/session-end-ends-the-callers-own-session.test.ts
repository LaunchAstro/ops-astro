// SPDX-License-Identifier: AGPL-3.0-only
//
// `session.end` (C23) writes `session ended (sign-out)` on the audit chain. On
// main it ended nothing at the door, so an API client or `ops-astro
// session.end` was recorded as signed out while its bearer still wrote (#2427).
// It now ends the caller's own session, here and in every business the login
// reaches, in the same transaction as its audit event, and nobody else's. The
// browser sends it first and then the sign-out route (C23's order), which
// finds its session already ended: that route still signs out at the provider,
// so no provider session is left behind.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bearer, call, personPath, serverUrl } from '../acceptance/world.ts';
import {
  api,
  clientA,
  clientB,
  eventsFor,
  EXPIRED,
  forgetSeen,
  OK,
  seen,
  served,
  sessions,
  tokenFor,
  useSessionsWorld,
} from './c58-sessions-world.ts';

useSessionsWorld();

const endSession = async (token: string, body: Record<string, unknown> = {}) =>
  await call(
    api,
    personPath('alpha', '/session/end'),
    { operationId: randomUUID(), ...body },
    bearer(token),
  );

/** A write every signed-in person may make: their own appearance. */
const save = async (token: string) =>
  await call(
    api,
    personPath('alpha', '/preference/save'),
    { operationId: randomUUID(), preference: 'appearance', value: 'dark' },
    bearer(token),
  );

describe.skipIf(serverUrl === undefined)(
  'session.end ends the caller’s own session (#2427)',
  () => {
    it('after session.end the same bearer neither writes nor reads; the person’s other session and another person go on', async () => {
      const [here, other] = [randomUUID(), randomUUID()];
      const token = await tokenFor(clientB.presented.subject, here);
      const otherToken = await tokenFor(clientB.presented.subject, other);
      const someoneElse = await tokenFor(clientA.presented.subject, randomUUID());
      expect((await save(token)).code).toBe('ok');

      const ended = await endSession(token);
      expect(ended.status).toBe(200);
      expect(ended.body).toMatchObject({ detail: { ended: 'sign-out' } });
      expect((await eventsFor('session.end')).at(-1)).toEqual({
        outcome: 'applied',
        refusal_code: null,
      });

      const after = await save(token);
      expect({ status: after.status, code: after.code }).toEqual(EXPIRED);
      expect(await served(token)).toEqual(EXPIRED);
      expect(await served(otherToken)).toEqual(OK);
      expect((await save(otherToken)).code).toBe('ok');
      expect(await served(someoneElse)).toEqual(OK);
    });

    it('a refused session.end (a body naming someone) ends nothing: check first, then act', async () => {
      const token = await tokenFor(clientB.presented.subject, randomUUID());
      const refused = await endSession(token, { personId: clientA.presented.subject });
      expect(refused.code).not.toBe('ok');
      expect(await served(token)).toEqual(OK);
      expect((await save(token)).code).toBe('ok');
    });

    it('the browser’s pair, session.end then the sign-out route, still signs out at the provider', async () => {
      const token = await tokenFor(clientB.presented.subject, randomUUID());
      forgetSeen();
      expect((await endSession(token)).status).toBe(200);
      await sessions('sign-out', token);
      expect(seen).toEqual([
        { route: 'POST /logout?scope=local', authorization: `Bearer ${token}` },
      ]);
      expect(await served(token)).toEqual(EXPIRED);
    });
  },
);
