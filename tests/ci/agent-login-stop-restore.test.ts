// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent login tool's stop and restore (scripts/ops/agent-login.ts). A stop
// switches the agent off, revokes its delegations, refuses its old bearers in
// every business and bans its provider user; a subject live in another
// business is ended nowhere and recorded shared; a ban the provider did not
// make is owed on a committed receipt, and a later stop bans the receipt's
// subject. A restore makes a new user and leaves the old one banned, and
// refuses after a credential revoked since the stop, while a ban is owed, and
// for an agent the tool did not switch off. A stop racing a make waits on the
// agent's lock. Nothing secret is printed or stored.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  actsOf,
  agentOf,
  makeArgs,
  makeWorld,
  mappingsOf,
  runAct,
  secret,
  waitingOnTheLock,
  type World,
} from './agent-login.fixture.ts';
import { delegate, door, made } from './agent-login-acts.fixture.ts';
import { providerUsers, runCommand } from './agent-login-provider.fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
// The pooler's name reaches this server on loopback, as in the command's own process.
await import(new URL('../support/pooler-at-loopback.mjs', import.meta.url).href);
Reflect.set(globalThis, Symbol.for('ops-astro.test.plaintext-at-loopback'), true);

let world: World;
const users = providerUsers();
const stop = async (agent: string) => await runAct(world, { args: ['stop', '--agent', agent] });
const puts = (): string[] => world.provider.calls.filter((call) => call.startsWith('PUT'));
const row = async (sql: string, agent: string): Promise<Record<string, unknown> | undefined> =>
  (await world.db.admin.execute<Record<string, unknown>>(sql, [agent]))[0];

async function stopsAndBans(): Promise<void> {
  const { agent, subject } = await made(world);
  await delegate(world, agent);
  expect(await door(world, subject)).toBe('answered');
  const stopped = await stop(agent);
  expect(stopped.printed).toContain('banned');
  expect(stopped.status).toBe(0);
  expect(await door(world, subject)).toMatch(/^AUTH_/u);
  expect(puts()).toContain(`PUT /admin/users/${subject}`);
  expect(users.list.find((user) => user.id === subject)?.banned_until).toBeDefined();
  expect(await mappingsOf(world, agent)).toHaveLength(0);
  const actor = await row('select active from public.actors where id = $1', agent);
  expect(actor).toEqual({ active: false });
  const revoked = await row(
    'select revocation_cause as cause from public.delegations where agent_actor_id = $1',
    agent,
  );
  expect(revoked).toEqual({ cause: 'delegation_revoked' });
  const receipt = (await actsOf(world, agent)).find((act) => act['act'] === 'stop');
  expect(receipt).toMatchObject({ ban: 'done', sessions_ended: true, provider_subject: subject });
}

async function sharedEndsNothing(): Promise<void> {
  const { agent, subject } = await made(world);
  await world.db.admin.execute(
    `with p as (insert into public.people (business_id, id, display_name)
                values ($1, gen_random_uuid(), 'Bo') returning id),
          a as (insert into public.actors (business_id, id, kind, person_id, active)
                select $1, gen_random_uuid(), 'person', id, true from p returning id, person_id),
          l as (insert into public.logins (business_id, id, provider, subject)
                values ($1, gen_random_uuid(), 'supabase', $2) returning id)
     insert into public.person_logins (business_id, id, login_id, person_id, active, linked_by_actor_id)
     select $1, gen_random_uuid(), l.id, a.person_id, true, a.id from l, a`,
    [world.beta, subject],
  );
  const calls = puts().length;
  const stopped = await stop(agent);
  expect(stopped.printed).toContain('live in another business');
  expect(stopped.status).toBe(0);
  expect(puts()).toHaveLength(calls);
  const receipt = (await actsOf(world, agent)).find((act) => act['act'] === 'stop');
  expect(receipt).toMatchObject({ ban: 'shared', sessions_ended: false });
  expect(await mappingsOf(world, agent)).toHaveLength(0);
}

/** A stop while the provider is down: a committed receipt that owes the ban of `subject`. */
async function stopOwing(agent: string, subject: string): Promise<void> {
  users.down = true;
  const down = await stop(agent);
  users.down = false;
  expect(down.printed).toContain('owed');
  expect(down.status).toBe(1);
  const receipt = (await actsOf(world, agent)).find((act) => act['act'] === 'stop');
  expect(receipt).toMatchObject({ ban: 'owed', closed_at: null, provider_subject: subject });
  expect(await mappingsOf(world, agent)).toHaveLength(0);
  expect(await row('select active from public.actors where id = $1', agent)).toEqual({
    active: false,
  });
}

async function owesTheBan(): Promise<void> {
  const { agent, subject } = await made(world);
  await stopOwing(agent, subject);
}

async function bansTheReceiptSubject(): Promise<void> {
  const { agent, subject } = await made(world);
  await stopOwing(agent, subject);
  // A login bound since, as a later generation would be: the owed ban is still the receipt's.
  const later = randomUUID();
  await world.db.admin.execute(
    `with l as (insert into public.logins (business_id, id, provider, subject)
                values ($1, gen_random_uuid(), 'supabase', $2) returning id)
     insert into public.actor_logins (business_id, id, login_id, actor_id, active, linked_by_actor_id)
     select $1, gen_random_uuid(), l.id, $3, true, $4 from l`,
    [world.alpha, later, agent, world.ownerActor],
  );
  const calls = puts().length;
  expect((await stop(agent)).status).toBe(0);
  expect(puts().slice(calls)).toStrictEqual([
    `PUT /admin/users/${subject}`,
    `PUT /admin/users/${later}`,
  ]);
  const bans = (await actsOf(world, agent)).filter((act) => act['act'] === 'stop');
  expect(bans.map((act) => [act['provider_subject'], act['ban']])).toStrictEqual([
    [subject, 'done'],
    [later, 'done'],
  ]);
}

async function restoresANewUser(): Promise<void> {
  const { agent, email, subject } = await made(world);
  await delegate(world, agent);
  expect((await stop(agent)).status).toBe(0);
  const password = secret();
  const restored = await runAct(world, {
    args: ['restore', ...makeArgs(agent, email).slice(1)],
    password,
  });
  expect(restored.printed).toContain('restored');
  expect(restored.status).toBe(0);
  const act = (await actsOf(world, agent)).find((one) => one['act'] === 'restore');
  expect(act).toMatchObject({ phase: 'probed', generation: 2, email: email.replace('@', '+g2@') });
  const [mapping] = await mappingsOf(world, agent);
  expect(mapping?.subject).toBe(act?.['provider_subject']);
  expect(mapping?.subject).not.toBe(subject);
  expect(users.list.find((user) => user.id === subject)?.banned_until).toBeDefined();
  expect(await door(world, subject)).toMatch(/^AUTH_/u);
  expect(await door(world, mapping?.subject ?? '')).toBe('answered');
  const live = await row(
    'select count(*)::int as n from public.delegations where agent_actor_id = $1 and revoked_at is null',
    agent,
  );
  expect(live).toEqual({ n: 0 });
}

const RESTORE_REFUSALS: Record<string, [(agent: string) => Promise<void>, string]> = {
  'a-credential-revoked-since-the-stop': [
    async (agent) => {
      expect((await stop(agent)).status).toBe(0);
      await world.db.admin.transaction(async (execute) => {
        await execute('set local session_replication_role = replica');
        await execute(
          `insert into public.agent_credentials (business_id, id, agent_actor_id, issued_by_person_id,
             issued_by_actor_id, purpose, scope, credential_hash, credential_scheme,
             credential_key_id, expires_at, revoked_at, revoked_by_actor_id)
           values ($1, gen_random_uuid(), $2, $3, $4, 'task_work', '{task:read}', repeat('b', 64),
             'hmac-sha256-v1', 'k1', now() + interval '1 day', clock_timestamp(), $4)`,
          [world.alpha, agent, world.ownerPerson, world.ownerActor],
        );
      });
    },
    'revoked since the stop',
  ],
  'while-a-ban-is-owed': [
    async (agent) => {
      users.down = true;
      expect((await stop(agent)).status).toBe(1);
      users.down = false;
    },
    'owes its ban',
  ],
  'an-agent-it-did-not-switch-off': [
    async (agent) => {
      await world.db.admin.execute(
        'update public.actors set active = false, deactivated_at = now() where id = $1',
        [agent],
      );
    },
    'not switched off by this tool',
  ],
};

async function restoreRefuses(name: string): Promise<void> {
  const { agent, email } = await made(world);
  const [setUp, words] = RESTORE_REFUSALS[name] ?? [];
  await setUp?.(agent);
  const before = await actsOf(world, agent);
  const args = ['restore', ...makeArgs(agent, email).slice(1)];
  const refused = await runAct(world, { args, password: secret() });
  expect(refused.printed).toContain(words);
  expect(refused.status).toBe(1);
  expect(await actsOf(world, agent)).toEqual(before);
}

async function stopWaitsOnAMake(): Promise<void> {
  const agent = await agentOf(world);
  const gates = { release: (): void => {}, reached: (): void => {} };
  const held = new Promise<void>((resolve) => {
    gates.release = resolve;
  });
  const atReserve = new Promise<void>((resolve) => {
    gates.reached = resolve;
  });
  const hold = async (at: string): Promise<void> => {
    if (at !== 'reserve') return;
    gates.reached();
    await held;
  };
  const making = runAct(world, { args: makeArgs(agent), password: secret(), at: hold });
  await Promise.race([atReserve, making]);
  const stopping = stop(agent);
  // The stop waits on the agent's lock while the make holds it.
  await Promise.race([waitingOnTheLock(world), stopping]);
  gates.release();
  const [, stopped] = await Promise.all([making, stopping]);
  expect(stopped.status).toBe(0);
  expect(await mappingsOf(world, agent)).toHaveLength(0);
  expect(await row('select active from public.actors where id = $1', agent)).toEqual({
    active: false,
  });
}

async function keepsSecrets(): Promise<void> {
  const { agent, email } = await made(world);
  const password = secret();
  const stopped = await runCommand(world, ['stop', '--agent', agent], '');
  const restored = await runCommand(
    world,
    ['restore', ...makeArgs(agent, email).slice(1)],
    password,
  );
  expect(stopped.status).toBe(0);
  expect(restored.status).toBe(0);
  const record = readFileSync(
    join(world.env['OPS_ASTRO_DEPLOYMENTS'] ?? '', 'deployments.jsonl'),
    'utf8',
  );
  const stored = JSON.stringify(await actsOf(world, agent));
  for (const value of [password, ...world.secrets])
    for (const where of [stopped.printed, restored.printed, record, stored])
      expect(where.includes(value)).toBe(false);
  expect(`${stopped.printed}${restored.printed}${record}`).not.toContain(email.split('@')[0]);
}

describe.skipIf(serverUrl === undefined)('agent login: stop and restore', () => {
  beforeAll(async () => {
    world = await makeWorld(serverUrl ?? '', users.handle);
    users.world = world;
  }, 60_000);
  afterAll(async () => await world?.close());

  it('stop-refuses-new-calls-ends-old-bearers-and-bans', stopsAndBans, 60_000);
  it(
    'stop-of-a-subject-live-elsewhere-ends-nothing-globally-and-records-shared',
    sharedEndsNothing,
    60_000,
  );
  it('stop-with-the-provider-down-commits-a-receipt-owing-the-ban', owesTheBan, 60_000);
  it('stop-again-bans-the-receipt-subject-not-a-restored-one', bansTheReceiptSubject, 60_000);
  it('restore-makes-a-new-user-and-leaves-the-old-banned-and-refused', restoresANewUser, 60_000);
  it.each(Object.keys(RESTORE_REFUSALS))('restore-refuses-%s', restoreRefuses, 60_000);
  it('a-stop-racing-a-make-waits-on-the-agent-lock', stopWaitsOnAMake, 60_000);
  it('no-act-prints-or-records-a-secret (stop and restore)', keepsSecrets, 60_000);
});
