// SPDX-License-Identifier: AGPL-3.0-only
//
// The Vercel function entry (ticket S0-6, the Vercel re-plan, section 5's
// `server.ts` row and the promotion row): the same `composeApi` the local
// server listens with, handed each request only when it is addressed to the
// environment's own host. A deployment's generated address, a spoofed
// forwarding header or a near-miss spelling is refused before anything is
// read, which is what lets a promotion leave the previous deployment serving
// nothing. A missing or bad setting stops the entry, naming the setting and
// never a value.

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFunctionHandler } from '../../apps/api/function.ts';
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { serveTestKeySet, type ServedKeySet } from '../support/sign-in.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  ISSUER,
  tokenFor,
  type ApiFixture,
} from './fixture.ts';

const HOST = 'ops.example.test';
const NO_STORE = 'private, no-store';
/** Nothing listens here: an answer that needed the database would fail. */
const NOWHERE = 'postgres://app:entry-canary-7f3c@127.0.0.1:1/none';

type Settings = Record<string, string | undefined>;

const KEY_ID = 'test/function-entry@1';
/** The delegation keyring, from the settings alone: a function has no key file. */
const KEYRING = {
  DELEGATION_CREDENTIAL_KEY_ID: KEY_ID,
  DELEGATION_CREDENTIAL_KEYS: `${KEY_ID}:${randomBytes(32).toString('base64url')}`,
};

const unreachable: Settings = {
  ...KEYRING,
  DATABASE_URL: NOWHERE,
  DATABASE_ADMIN_URL: NOWHERE,
  GOTRUE_URL: ISSUER,
  SERVED_HOST: HOST,
};

function request(host: string, path = '/api/health', init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('host', host);
  return new Request(`https://${host}${path}`, { ...init, headers });
}

describe('S0-6 the function entry answers only its own host', () => {
  hostCase();
  settingsCase();
});

function hostCase() {
  it('refuses every other host with 421, no-store and no body, reading nothing', async () => {
    const handle = createFunctionHandler(unreachable);
    const refused = [
      'ops-a1b2c3d4e.vercel.app',
      `${HOST}.`,
      `${HOST}:443`,
      `x${HOST}`,
      `${HOST}.evil.test`,
      '',
    ];
    for (const host of refused) {
      // oxlint-disable-next-line no-await-in-loop -- each host named on its own line
      const response = await handle(request(host));
      expect(response.status, host).toBe(421);
      expect(response.headers.get('cache-control'), host).toBe(NO_STORE);
      // oxlint-disable-next-line no-await-in-loop -- as above
      expect(await response.text(), host).toBe('');
    }
    // A forwarding header naming the right host changes nothing.
    const spoofed = await handle(
      request('ops-a1b2c3d4e.vercel.app', '/api/health', {
        headers: { 'x-forwarded-host': HOST },
      }),
    );
    expect(spoofed.status).toBe(421);
    // The same entry, its own host: the app answers, and says the database is not there.
    const own = await handle(request(HOST.toUpperCase()));
    expect(own.status).toBe(503);
    expect(await own.json()).toMatchObject({ database: 'unreachable' });
  });
}

function settingsCase() {
  it('refuses to start without each setting, naming it and never a value', () => {
    const names = ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'GOTRUE_URL', 'SERVED_HOST'];
    for (const name of [...names, ...Object.keys(KEYRING)]) {
      for (const value of [undefined, '']) {
        const start = () => createFunctionHandler({ ...unreachable, [name]: value });
        expect(start, name).toThrow(name);
      }
    }
    const hosted = { ...unreachable, GOTRUE_URL: 'https://project.supabase.co/auth/v1' };
    const refused: readonly Settings[] = [
      // A stand-in key set is for a loopback issuer only.
      { ...hosted, SUPABASE_KEY_SET_URL: 'http://127.0.0.1:9/jwks.json' },
      // A host with a scheme, a path or a port is not a host.
      { ...unreachable, SERVED_HOST: `https://${HOST}` },
      { ...unreachable, SERVED_HOST: `${HOST}/api` },
      { ...unreachable, SERVED_HOST: `${HOST}:443` },
    ];
    for (const settings of refused) {
      let message = '';
      try {
        createFunctionHandler(settings);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, JSON.stringify(settings['SERVED_HOST'])).not.toBe('');
      expect(message).not.toContain('entry-canary-7f3c');
      expect(message).not.toContain('127.0.0.1:9');
    }
  });
}

let fixture: ApiFixture | undefined;
let keySet: ServedKeySet | undefined;

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'S0-6 the function entry serves the composed app',
  () => {
    beforeAll(async () => {
      fixture = await createApiFixture('fnentry');
      keySet = await serveTestKeySet();
    }, 60_000);
    afterAll(async () => {
      await keySet?.close();
      await fixture?.drop();
    });

    it('a signed-in read on its own host, private and no-store', async () => {
      const world = fixture as ApiFixture;
      const admin = new URL(process.env['DATABASE_ADMIN_URL'] ?? '');
      admin.pathname = `/${world.db.name}`;
      const handle = createFunctionHandler({
        ...world.environment,
        ...KEYRING,
        DATABASE_URL: world.db.appUrl,
        DATABASE_ADMIN_URL: admin.href,
        GOTRUE_URL: ISSUER,
        SUPABASE_KEY_SET_URL: (keySet as ServedKeySet).url,
        SERVED_HOST: HOST,
      });
      const token = await tokenFor(world.member.presented.subject);
      const board = `${PREFIX.person}${BUSINESS_KEY}/task/board`;
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authorised(token) },
        body: '{"board":null}',
      };

      const health = await handle(request(HOST));
      expect(health.status).toBe(200);
      const read = await handle(request(HOST, board, init));
      expect(read.status).toBe(200);
      expect(read.headers.get('cache-control')).toBe(NO_STORE);
      // The same signed-in read at the deployment's own address is refused.
      const elsewhere = await handle(request('ops-a1b2c3d4e.vercel.app', board, init));
      expect(elsewhere.status).toBe(421);
    });
  },
);
