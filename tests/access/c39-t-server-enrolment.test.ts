// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T's enrolment route as the server serves it. `apps/api/server.ts` is
// started as its own OS process over the enrolment world's database, its
// deployment alpha alone. With `ENROLMENT=on` it answers `POST /api/enrol`:
// an alpha link makes its login at the stand-in login provider through the
// server's own custody, which alone read the service key, and a bravo link,
// outside the deployment's businesses, is not found and asks nothing. Unset,
// there is no such route. On with a setting missing, or any other value, the
// server stops before it listens. The broker it builds catalogues the login
// provider's two operations and nothing else, and custody sends the one PUT.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { enrolmentSettings, startEnrolment } from '../../apps/api/enrolment-broker.ts';
import type { Method } from '../../packages/core-custody/src/egress-routes.ts';
import { serveApi } from '../support/served-api.ts';
import { e, invited, passwordFor, spentOf, useEnrolWorld } from './c39-t-enrol-world.ts';
import { addressFor, c, noDatabase, w } from './c39-t-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEnrolWorld();

let folder = '';
let credentialsFile = '';

/** Custody's file for the server: the service key alone, for the `auth` destination. */
beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'c39t-server-enrol-'));
  credentialsFile = join(folder, 'credentials.json');
  const credential = { kind: 'api_key', account: 'auth-1', header: 'authorization', value: e.key };
  writeFileSync(
    credentialsFile,
    JSON.stringify([{ ref: 'auth_key', destination: 'auth', ...credential }]),
    { mode: 0o600 },
  );
});

afterAll(() => {
  if (folder !== '') rmSync(folder, { recursive: true, force: true });
});

const enrolmentOn = (): Record<string, string> => ({
  ENROLMENT: 'on',
  ENROLMENT_AUTH_ORIGIN: e.users.origin,
  ENROLMENT_CREDENTIALS_FILE: credentialsFile,
});

/** POST the token and a password to the served route, as the enrolment page does. */
async function enrolAt(origin: string, token: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${origin}/api/enrol`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, password: passwordFor() }),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, body: text };
  }
}

it("C39-T enrolment served: with enrolment on, POST /api/enrol enrols a link of the deployment's businesses through the server's own custody, and its log never holds the service key", async () => {
  const alpha = await invited(c.admin, addressFor('served'));
  const bravo = await invited(c.bravoAdmin, addressFor('served-bravo'), w.bravo);
  const served = await serveApi(w.db, 'alpha', enrolmentOn());
  try {
    expect(served.ready, served.output()).toBe(true);
    const asked = e.users.received.length;
    expect(await enrolAt(served.origin, bravo.token)).toStrictEqual({
      status: 404,
      body: { code: 'ENROLMENT_LINK_INVALID' },
    });
    expect(e.users.received.length).toBe(asked);
    expect(await enrolAt(served.origin, alpha.token)).toStrictEqual({
      status: 200,
      body: { state: 'enrolled' },
    });
    const made = e.users.received.slice(asked);
    expect(made.map((request) => `${request.method} ${request.path}`)).toStrictEqual([
      'POST /auth/v1/admin/users',
    ]);
    expect(made[0]?.authorization).toBe(`Bearer ${e.key}`);
    expect(await spentOf(alpha.id)).toStrictEqual({ state: 'accepted', spent: 1, tokens: 1 });
    expect(await spentOf(bravo.id)).toStrictEqual({ state: 'pending', spent: 0, tokens: 1 });
  } finally {
    expect(await served.stop()).toBe(0);
  }
  expect(served.output()).toContain('api: enrolment on');
  expect(served.output()).not.toContain(e.key);
}, 90_000);

it('C39-T enrolment served: with enrolment unset, the server has no POST /api/enrol and a live link asks the login provider nothing', async () => {
  const alpha = await invited(c.admin, addressFor('unserved'));
  const served = await serveApi(w.db, 'alpha', {});
  try {
    expect(served.ready, served.output()).toBe(true);
    const asked = e.users.received.length;
    expect(await enrolAt(served.origin, alpha.token)).toStrictEqual({
      status: 404,
      body: '404 Not Found',
    });
    expect(e.users.received.length).toBe(asked);
    expect(await spentOf(alpha.id)).toStrictEqual({ state: 'pending', spent: 0, tokens: 1 });
  } finally {
    expect(await served.stop()).toBe(0);
  }
  expect(served.output()).toContain('api: enrolment off');
}, 90_000);

it("C39-T enrolment served: enrolment on without the login provider's origin, or set in any form but on or off, stops the server before it listens", async () => {
  const cases: readonly [Record<string, string>, string][] = [
    [{ ...enrolmentOn(), ENROLMENT_AUTH_ORIGIN: '' }, 'ENROLMENT_AUTH_ORIGIN'],
    [{ ...enrolmentOn(), ENROLMENT: 'yes' }, 'ENROLMENT is neither on nor off'],
  ];
  for (const [settings, named] of cases) {
    // oxlint-disable-next-line no-await-in-loop -- one server at a time
    const served = await serveApi(w.db, 'alpha', settings);
    expect(served.ready).toBe(false);
    // oxlint-disable-next-line no-await-in-loop -- one server at a time
    expect(await served.stop()).toBe(1);
    expect(served.output()).toContain(named);
    expect(served.output()).not.toContain('api: listening');
  }
}, 90_000);

it("C39-T enrolment settings: the login provider's origin is a bare https origin, or http on this machine only, and a problem names the setting, never its value", () => {
  const problem = (settings: Record<string, string>): string => {
    const read = enrolmentSettings({ ...enrolmentOn(), ...settings });
    return read.kind === 'invalid' ? read.problem : read.kind;
  };
  expect(problem({ ENROLMENT_AUTH_ORIGIN: 'http://auth.example.test' })).toBe(
    'ENROLMENT_AUTH_ORIGIN is plain http off this machine; use https',
  );
  expect(problem({ ENROLMENT_AUTH_ORIGIN: 'https://auth.example.test/auth/v1' })).toBe(
    'ENROLMENT_AUTH_ORIGIN is not a bare http(s) origin',
  );
  expect(problem({ ENROLMENT_CREDENTIALS_FILE: '' })).toBe(
    'enrolment is on but not set: ENROLMENT_CREDENTIALS_FILE',
  );
  expect(problem({ ENROLMENT_AUTH_ORIGIN: 'https://auth.example.test' })).toBe('on');
  expect(enrolmentSettings({}).kind).toBe('off');
  expect(enrolmentSettings({ ...enrolmentOn(), ENROLMENT: 'off' }).kind).toBe('off');
});

it("C39-T enrolment broker: it catalogues auth.create_user and auth.update_user and nothing else, its custody sends the login provider no other PUT, and the key stays out of this process's settings and environment", async () => {
  const settings = enrolmentSettings(enrolmentOn());
  if (settings.kind !== 'on') throw new Error(`enrolment settings: ${settings.kind}`);
  expect(settings.destination).toStrictEqual({
    key: 'auth',
    origin: e.users.origin,
    routes: [{ method: 'PUT', path: '/auth/v1/admin/users/*' }],
  });
  const started = await startEnrolment(settings, async () => await Promise.resolve([w.alpha]));
  try {
    const { broker } = started.options;
    expect([...broker.operations.keys()].toSorted()).toStrictEqual([
      'auth.create_user',
      'auth.update_user',
    ]);
    expect(broker.routes.map((route) => [route.provider, route.credentialRef])).toStrictEqual([
      ['supabase_auth', 'auth_key'],
      ['supabase_auth_update', 'auth_key'],
    ]);
    const asked = e.users.received.length;
    const unrouted: readonly [Method, string][] = [
      ['PUT', '/auth/v1/admin/users'],
      ['PUT', '/auth/v1/admin/factors/one'],
      ['DELETE', `/auth/v1/admin/users/${randomUUID()}`],
      ['GET', '/auth/v1/admin/users'],
    ];
    for (const [method, path] of unrouted) {
      const request = { method, path, body: '{}', timeoutMs: 600, maxResponseBytes: 1024 };
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      const outcome = await broker.custody.dispatch('auth_key', {
        destination: 'auth',
        ...request,
      });
      expect(outcome.kind === 'answered' && outcome.outbound.ok, `${method} ${path}`).toBe(false);
    }
    expect(e.users.received.length).toBe(asked);
    expect(JSON.stringify(settings)).not.toContain(e.key);
    expect(Object.values(process.env).join('\n')).not.toContain(e.key);
  } finally {
    await started.stop();
  }
}, 30_000);
