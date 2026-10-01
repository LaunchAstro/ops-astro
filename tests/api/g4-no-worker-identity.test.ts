// SPDX-License-Identifier: AGPL-3.0-only
//
// G4, closed as no worker endpoint (the orchestrator's ruling G4-SHAPE, option
// A). The re-plan (section 6) gives each worker a service identity scoped to
// its own endpoints on the web app. After STEP2-SHAPE the worker's jobs hold
// database logins only (the outbox forwarder, the backup and the drill), and
// `apps/worker` is an agent client under one delegation, so there is no worker
// endpoint to scope an identity to. This pins that: every route the API serves
// is a person's or an agent's command, or one of the named few, and the
// function entry reads no setting that could hold a worker's public half. A
// worker endpoint added later fails here and brings G4 back.

import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { keySetUrlFor } from '../../apps/api/auth/supabase.ts';
import { createFunctionHandler } from '../../apps/api/function.ts';
import { composeApi } from '../../apps/api/server.ts';
import { connect, connectAsAdmin } from '../../packages/core-records/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/index.ts';
import { TEST_ISSUER as ISSUER } from '../support/sign-in.ts';

/** Nothing listens here: building the API opens no connection. */
const NOWHERE = 'postgres://app:g4@127.0.0.1:1/none';
const KEYRING = {
  DELEGATION_CREDENTIAL_KEY_ID: 'test/g4@1',
  DELEGATION_CREDENTIAL_KEYS: `test/g4@1:${randomBytes(32).toString('base64url')}`,
};
const COMMAND = /^POST \/api\/(?:a\/)?b\/:businessKey\/[a-z_]+\/[a-z_]+$/u;
const OTHERS = [
  'ALL /*',
  'ALL /api/*',
  'GET /api/health',
  'GET /api/sign-in',
  'POST /api/session',
  'POST /api/session/end',
];
const SETTINGS = [
  'ALERT_SCOPE_KEY',
  'DATABASE_LOOKUP_URL',
  'DATABASE_URL',
  'DELEGATION_CREDENTIAL_KEYS',
  'DELEGATION_CREDENTIAL_KEY_ID',
  'GATE_SIGNING_KEY_ID',
  'GATE_SIGNING_SECRET',
  'GOTRUE_URL',
  'OPS_ASTRO_CRASH_POINT',
  'OPS_ENVIRONMENT',
  'OPS_RELEASE',
  'RECOVERY_BUSINESS_KEYS',
  'SERVED_HOST',
  'SUPABASE_KEY_SET_URL',
  // S0-6: the provider's publishable key, public, for the page's sign-in.
  'SUPABASE_PUBLISHABLE_KEY',
];

it("G4: every route the API serves is a person's or an agent's command, or one of the named few", () => {
  const { app } = composeApi({
    database: connect(NOWHERE),
    admin: connectAsAdmin(NOWHERE),
    signIn: { issuer: ISSUER, keySetUrl: keySetUrlFor('', ISSUER) ?? '' },
    keys: runtimeKeys(KEYRING),
  });
  const routes = [...new Set(app.routes.map((route) => `${route.method} ${route.path}`))];
  expect(routes.filter((route) => COMMAND.test(route)).length).toBeGreaterThan(40);
  expect(routes.filter((route) => !COMMAND.test(route)).toSorted()).toStrictEqual(OTHERS);
  expect(routes.filter((route) => /worker|service/iu.test(route))).toStrictEqual([]);
});

it('G4: the function entry reads no setting that could hold a worker identity', () => {
  const read = new Set<string>();
  const given: Record<string, string> = {
    ...KEYRING,
    DATABASE_URL: NOWHERE,
    GOTRUE_URL: ISSUER,
    SERVED_HOST: 'ops.example.test',
    OPS_ENVIRONMENT: 'staging',
    ALERT_SCOPE_KEY: 'ab'.repeat(32),
    RECOVERY_BUSINESS_KEYS: 'none',
  };
  const settings = new Proxy(given, {
    get: (target, name) => {
      if (typeof name === 'string') read.add(name);
      return typeof name === 'string' ? target[name] : undefined;
    },
  });
  createFunctionHandler(settings);
  expect([...read].toSorted()).toStrictEqual(SETTINGS);
});
