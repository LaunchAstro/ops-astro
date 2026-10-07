// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGoTrueLogins } from '../../apps/api/auth/logins.ts';
import { serverUrl } from '../acceptance/world.ts';
import { freshSubject } from '../commands/fixture.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import {
  apiWith,
  end,
  harness,
  outcome,
  ownCall,
  signedIn,
  stateOf,
  useEndAccessWorld,
} from '../authority/c58-end-access-world.ts';

useEndAccessWorld();

describe.skipIf(serverUrl === undefined)('POST /api/b/alpha/access/end', () => {
  it('settles both provider steps with an admin user response larger than 16 KiB and keeps access ended', async () => {
    const subject = randomUUID();
    const person = await harness.world.db.app.withBusiness(harness.world.alpha, async (tx) => {
      const personId = await insertPerson(tx, 'large-admin-user');
      const actorId = await insertActor(tx, personId);
      await insertMembership(tx, personId);
      await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
      return { personId, actorId, presented: freshSubject(subject) };
    });
    const body = JSON.stringify({
      id: subject,
      banned_until: '2999-01-01T00:00:00Z',
      user_metadata: { notes: 'a'.repeat(32 * 1024) },
    });
    expect(Buffer.byteLength(body)).toBeGreaterThan(16 * 1024);
    const sent: string[] = [];
    const logins = createGoTrueLogins({
      baseUrl: 'http://127.0.0.1:9/auth/v1',
      adminKey: () => Promise.resolve('test-only-admin-key'),
      fetch: (input, init) => {
        expect(init?.method).toBe('PUT');
        sent.push(String(input));
        return Promise.resolve(new Response(body));
      },
    });
    const api = apiWith(logins);
    expect(outcome(await end(api, person.personId))).toEqual({ status: 200, code: 'ok' });
    expect((await stateOf(person)).endings).toEqual([
      {
        sessions: true,
        login: true,
        attempts: 1,
        fault: null,
        by: harness.world.ada.actorId,
      },
    ]);
    expect(sent).toEqual([
      `http://127.0.0.1:9/auth/v1/admin/users/${subject}`,
      `http://127.0.0.1:9/auth/v1/admin/users/${subject}`,
    ]);
    const token = await signedIn(subject, Math.floor(Date.now() / 1000) - 60);
    expect(outcome(await ownCall(api, token))).toEqual({
      status: 403,
      code: 'AUTH_ACCESS_ENDED',
    });
  });
});
