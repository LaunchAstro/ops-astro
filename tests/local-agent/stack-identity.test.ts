// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859): the stack names the tick's business, agent and worker. With
// OPS_LOCAL_AGENT_BUSINESS set to a made-up business's key it asks the local
// seed for them and writes them into `api.env`, so the tick process starts from
// that one file; a business the seed has not made refuses before anything is
// written. The database side is stubbed here; seed.test.ts runs it for real.

import { existsSync, readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { readApiEnv, startStack, type Stack } from '../../apps/local-agent/stack.ts';
import { tickSettings } from '../../apps/local-agent/tick-main.ts';
import {
  agentSubjectOf,
  identityFromSeed,
  type IdentityRead,
} from '../../apps/local-agent/seed.ts';
import { makeWorld, type World } from './world.ts';

const BUSINESS = '6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b';
const SUBJECT = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const WORKER = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';

let world: World | undefined;
let stack: Stack | undefined;
const asked: string[] = [];
const print = (): void => undefined;

afterEach(async () => {
  await stack?.close();
  stack = undefined;
  world?.remove();
  world = undefined;
  asked.length = 0;
});

const seeded =
  (read: IdentityRead) =>
  async (env: Readonly<Record<string, string | undefined>>): Promise<IdentityRead> => {
    asked.push(env['OPS_LOCAL_AGENT_BUSINESS'] ?? '');
    return read;
  };

const found: IdentityRead = {
  ok: true,
  identity: { businessId: BUSINESS, agentSubject: SUBJECT, workerActorId: WORKER },
};

it("the local stack writes the made-up business's id, agent subject and worker into api.env", async () => {
  world = makeWorld();
  const env = { ...world.env, OPS_LOCAL_AGENT_BUSINESS: 'alpha' };
  const result = await startStack(env, world.userHome, print, seeded(found));
  if (!result.ok) throw new Error(`stack refused: ${result.code}`);
  stack = result.stack;
  expect(asked).toEqual(['alpha']);
  const written = readApiEnv(readFileSync(stack.apiEnvFile, 'utf8'));
  expect(written).toMatchObject({
    OPS_LOCAL_AGENT_BUSINESS_ID: BUSINESS,
    OPS_LOCAL_AGENT_AGENT_SUBJECT: SUBJECT,
    OPS_LOCAL_AGENT_WORKER_ACTOR_ID: WORKER,
  });
  // The tick reads exactly these, once a database is named.
  const tick = tickSettings({ ...written, DATABASE_URL: 'postgres://127.0.0.1/db' });
  expect(tick).toMatchObject({
    ok: true,
    settings: { businessId: BUSINESS, agent: { subject: SUBJECT }, workerActorId: WORKER },
  });
});

it('a business the local seed has not made refuses the stack before anything is written', async () => {
  world = makeWorld();
  const env = { ...world.env, OPS_LOCAL_AGENT_BUSINESS: 'alpha' };
  const refused: IdentityRead = { ok: false, code: 'NOT_SEEDED', message: 'run pnpm db:seed' };
  const result = await startStack(env, world.userHome, print, seeded(refused));
  expect(result).toMatchObject({ ok: false, code: 'NOT_SEEDED' });
  expect(existsSync(world.agentHome)).toBe(false);
});

it('without OPS_LOCAL_AGENT_BUSINESS the stack asks no database and writes no tick identity', async () => {
  world = makeWorld();
  const result = await startStack(world.env, world.userHome, print, seeded(found));
  if (!result.ok) throw new Error(`stack refused: ${result.code}`);
  stack = result.stack;
  expect(asked).toEqual([]);
  const written = readApiEnv(readFileSync(stack.apiEnvFile, 'utf8'));
  expect(written['OPS_LOCAL_AGENT_AGENT_SUBJECT']).toBeUndefined();
});

it('outside OPS_ENVIRONMENT=local the stack refuses before it asks the seed anything', async () => {
  world = makeWorld();
  const env = { ...world.env, OPS_ENVIRONMENT: 'staging', OPS_LOCAL_AGENT_BUSINESS: 'alpha' };
  const result = await startStack(env, world.userHome, print, seeded(found));
  expect(result).toMatchObject({ ok: false, code: 'LOCAL_ONLY' });
  expect(asked).toEqual([]);
});

it("the agent's subject is read from the seed's agents file by business key", () => {
  const agents = JSON.stringify([
    { business: 'alpha', email: 'agent-alpha@example.test', password: 'x', subject: SUBJECT },
    { business: 'bravo', email: 'agent-bravo@example.test', password: 'y', subject: WORKER },
  ]);
  expect(agentSubjectOf(agents, 'alpha')).toBe(SUBJECT);
  expect(agentSubjectOf(agents, 'bravo')).toBe(WORKER);
  expect(agentSubjectOf(agents, 'charlie')).toBeUndefined();
  expect(agentSubjectOf('not json', 'alpha')).toBeUndefined();
});

it('the seed lookup itself refuses outside OPS_ENVIRONMENT=local, opening nothing', async () => {
  const read = await identityFromSeed({
    OPS_ENVIRONMENT: 'staging',
    OPS_LOCAL_AGENT_BUSINESS: 'alpha',
  });
  expect(read).toMatchObject({ ok: false, code: 'LOCAL_ONLY' });
});

it('the seed lookup without a database or agents file says to run the seed', async () => {
  world = makeWorld();
  const read = await identityFromSeed({
    OPS_ENVIRONMENT: 'local',
    OPS_LOCAL_AGENT_BUSINESS: 'alpha',
    OPS_SEED_DIR: world.root,
  });
  expect(read).toMatchObject({ ok: false, code: 'NOT_SEEDED' });
});
