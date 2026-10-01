// SPDX-License-Identifier: AGPL-3.0-only
//
// The S0-2 canary suites' shared set-up (s0-2-canary.test.ts and
// s0-2-canary-sink.test.ts): the served composition (`composeApi`) with the
// sink as a fake transport that keeps every event, and a bearer for any
// subject.

import type { Hono } from 'hono';
import { composeApi } from '../../apps/api/server.ts';
import { createAlerts, type Alerts, type SinkEvent } from '../../apps/api/alerts/sink.ts';
import type { AdminConnection, Database } from '../../packages/core-records/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { COMMAND_SURFACE, pathOf } from '../../packages/core-wire/src/index.ts';
import { signBearer, TEST_ISSUER, testSignIn } from '../support/sign-in.ts';

const ISSUER: string = TEST_ISSUER;

const ALPHA = '11111111-1111-4111-8111-111111111111';

const READ = COMMAND_SURFACE.find((declaration) => declaration.kind === 'read');

if (READ === undefined) throw new Error('the surface declares no read');

export const READ_PATH: string = pathOf(READ.name);

export function served(executeRead: () => Promise<never>): {
  app: Hono;
  events: SinkEvent[];
  alerts: Alerts;
} {
  const events: SinkEvent[] = [];
  const alerts = createAlerts({
    send: (e) => Promise.resolve(void events.push(e)),
    where: 'staging',
    root: process.cwd(),
  });
  const execute = (_sql: string, parameters: readonly unknown[] = []) =>
    Promise.resolve(parameters[0] === 'alpha' ? [{ id: ALPHA }] : []);
  // The key is read in a transaction of its own, as the lookup identity (0046).
  const admin = {
    execute,
    transaction: (run: (inner: typeof execute) => Promise<unknown>) => run(execute),
  } as unknown as AdminConnection;
  const { app } = composeApi({
    database: {} as Database,
    admin,
    signIn: testSignIn(ISSUER),
    keys: runtimeKeys({}),
    executeRead: executeRead as never,
    alerts,
  });
  return { app, events, alerts };
}

export async function bearer(subject: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    sub: subject,
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    exp: now + 600,
  };
  return await signBearer(claims);
}
