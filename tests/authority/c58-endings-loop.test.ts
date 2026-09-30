// SPDX-License-Identifier: AGPL-3.0-only
//
// C58's provider steps off the API process (ORCH46 ruling B, ORCH47): the
// endings loop runs on the environment's machine and is the only process that
// holds the provider's admin key. It reads across businesses on the owner's
// login (business ids with an owed ending, and whether a login is live
// elsewhere) and nothing more; every settle runs on the application login,
// under that business's tenancy. The Vercel function holds neither the owner
// login, the shared-login check nor the key.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { endingsSettings, retryAccessEndings } from '../../apps/endings/pass.ts';
import { composeApi } from '../../apps/api/server.ts';
import type { AdminConnection } from '../../packages/core-records/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { ACCEPTANCE_ISSUER, bearer, personPath, serverUrl } from '../acceptance/world.ts';
import { testSignIn } from '../support/sign-in.ts';
import {
  apiWith,
  end,
  harness,
  outcome,
  scripted,
  stateOf,
  teammate,
  useEndAccessWorld,
} from './c58-end-access-world.ts';

useEndAccessWorld();

/** The statements logged since `from`, by the connection that sent them. */
function sentSince(from: number): { readonly owner: string[]; readonly app: string[] } {
  const since = harness.world.db.admin.log.entries.slice(from);
  const text = (source: string) =>
    since.filter((each) => each.source === source).map((each) => each.text.trim().toLowerCase());
  return { owner: text('migration'), app: text('runtime') };
}

/** The owner's connection, every statement it is sent noted first. */
function watched(admin: AdminConnection): { readonly owner: AdminConnection; seen: string[] } {
  const seen: string[] = [];
  const owner: AdminConnection = {
    ...admin,
    execute: async (text, parameters) => {
      seen.push(text);
      return await admin.execute(text, parameters);
    },
  };
  return { owner, seen };
}

async function noKeyComposition(): Promise<void> {
  const { person } = await teammate('nokey');
  const { owner, seen } = watched(harness.world.db.admin);
  const { app } = composeApi({
    database: harness.world.db.app,
    admin: owner,
    keys: runtimeKeys({}),
    signIn: testSignIn(ACCEPTANCE_ISSUER),
  });
  const response = await app.fetch(
    new Request(`http://api.test${personPath('alpha', '/access/end')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(harness.world.ada.token) },
      body: JSON.stringify({ operationId: randomUUID(), holderId: person.personId }),
    }),
  );
  expect(response.status).toBe(200);
  expect(seen.filter((text) => /\b(logins|person_logins|access_endings)\b/u.test(text))).toEqual(
    [],
  );
  expect((await stateOf(person)).endings).toEqual([
    expect.objectContaining({ sessions: false, login: false, attempts: 0 }),
  ]);
}

describe.skipIf(serverUrl === undefined)('C58 endings loop: the provider steps off the API', () => {
  it('C58 endings loop: the owner login only reads across businesses, and every settle runs on the app login', async () => {
    const { person } = await teammate('loop');
    // The act with no provider: both steps owed.
    expect(outcome(await end(apiWith(), person.personId))).toEqual({ status: 200, code: 'ok' });
    const { calls, provider } = scripted();
    const from = harness.world.db.admin.log.entries.length;

    expect(
      await retryAccessEndings(harness.world.db.admin, harness.world.db.app, provider, 0),
    ).toBe(0);

    const subject = person.presented.subject;
    expect(calls).toEqual([
      { step: 'endSessions', subject },
      { step: 'deactivate', subject },
    ]);
    const { owner, app } = sentSince(from);
    expect(owner.length).toBeGreaterThan(0);
    expect(owner.every((text) => text.startsWith('select'))).toBe(true);
    expect(app.some((text) => text.includes('update public.access_endings'))).toBe(true);
    expect((await stateOf(person)).endings).toEqual([
      expect.objectContaining({ sessions: true, login: true, fault: null }),
    ]);
  });

  it(
    'C58 endings loop: a composition with no provider key asks the owner login nothing about logins and calls no provider',
    noKeyComposition,
  );
});

describe('C58 endings loop: its settings', () => {
  const settings = {
    DATABASE_URL: 'postgres://app:loop-canary-1a@127.0.0.1:1/none',
    DATABASE_ADMIN_URL: 'postgres://owner:loop-canary-1a@127.0.0.1:1/none',
    GOTRUE_URL: 'https://abc.supabase.co/auth/v1',
    SUPABASE_SERVICE_KEY: 'loop-canary-1a-key',
  };

  it('C58 endings loop: it refuses to start without each setting, naming it and never a value', () => {
    expect(endingsSettings(settings)).toMatchObject({ ok: true });
    for (const name of Object.keys(settings)) {
      const answer = endingsSettings({ ...settings, [name]: '' });
      expect(answer, name).toMatchObject({ ok: false });
      expect(JSON.stringify(answer), name).toContain(name);
      expect(JSON.stringify(answer), name).not.toContain('loop-canary-1a');
    }
  });

  it('C58 endings loop: a plain-http issuer off loopback gets no key, so the loop refuses to start', () => {
    const answer = endingsSettings({ ...settings, GOTRUE_URL: 'http://auth.example.test/auth/v1' });
    expect(answer).toMatchObject({ ok: false });
    expect(JSON.stringify(answer)).toContain('GOTRUE_URL');
    expect(JSON.stringify(answer)).not.toContain('loop-canary-1a');
  });
});
