// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent login tool's make, phase by phase (scripts/ops/agent-login.ts):
// it binds a new sign-in to an agent and proves it by signing in as the agent
// and asking the agent door for its queue. A rerun resumes the open act from
// its phase with the stored credential and never sets a password; a make
// already done changes nothing; two runs at once wait on the agent's lock and
// leave one of everything. Nothing secret is printed or stored.

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
import { providerUsers, runCommand } from './agent-login-provider.fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
// The pooler's name reaches this server on loopback, as in the command's own process.
await import(new URL('../support/pooler-at-loopback.mjs', import.meta.url).href);
Reflect.set(globalThis, Symbol.for('ops-astro.test.plaintext-at-loopback'), true);

let world: World;
const users = providerUsers();
const record = (): string => {
  const file = join(world.env['OPS_ASTRO_DEPLOYMENTS'] ?? '', 'deployments.jsonl');
  return readFileSync(file, 'utf8');
};
const puts = (): string[] => world.provider.calls.filter((call) => call.startsWith('PUT'));

/** The agent's one act, probed, its one provider user holding `password`, its one live login. */
async function madeOnce(agent: string, password: string): Promise<Record<string, unknown>> {
  const [act, ...more] = await actsOf(world, agent);
  expect(more).toHaveLength(0);
  expect(act).toMatchObject({ phase: 'probed', probe: 'passed', generation: 1 });
  const held = users.list.filter((user) => user.id === act?.['provider_subject']);
  expect(held.map((user) => user.password)).toStrictEqual([password]);
  const mapped = await mappingsOf(world, agent);
  expect(mapped.map((one) => one.subject)).toStrictEqual([act?.['provider_subject']]);
  return act ?? {};
}

async function bindsAndProbes(): Promise<void> {
  const [agent, password] = [await agentOf(world), secret()];
  const made = await runAct(world, {
    args: makeArgs(agent, 'helper-one@example.test'),
    password,
  });
  expect(made.printed).toContain('made');
  expect(made.status).toBe(0);
  const act = await madeOnce(agent, password);
  expect(act).toMatchObject({
    act: 'make',
    email: 'helper-one+g1@example.test',
    custody_item: expect.stringMatching(/^Ops Astro Staging - Helper \d+ Agent Sign-in g1$/u),
    operator_person_id: world.operatorPerson,
  });
  const user = users.list.find((one) => one.id === act['provider_subject']);
  expect(user?.app_metadata).toStrictEqual({ ops_astro_login_act: act['id'] });
  const [mapping] = await mappingsOf(world, agent);
  expect(mapping?.linked_by_actor_id).toBe(world.ownerActor);
  const attempts = await world.db.admin.execute(
    `select actor_id from public.authentication_attempts
      where login_id = $1 and outcome = 'resolved' and owner = 'agent_login'`,
    [mapping?.login_id],
  );
  expect(attempts).toContainEqual({ actor_id: agent });
  expect(record()).toContain(String(act['id']));
}

/** A crash at `point`, then a rerun with the stored credential: made once, no password set. */
async function resumes(point: string): Promise<void> {
  const [agent, password] = [await agentOf(world), secret()];
  const args = makeArgs(agent);
  const crash = async (at: string): Promise<void> => {
    if (at === point) throw new Error(await Promise.resolve(`crashed at ${point}`));
  };
  expect((await runAct(world, { args, password, at: crash })).status).toBe(1);
  expect((await runAct(world, { args, password })).status).toBe(0);
  await madeOnce(agent, password);
  expect(puts()).toHaveLength(0);
}

const crashPastProvider = async (at: string): Promise<void> => {
  if (at === 'provider') throw new Error(await Promise.resolve('crashed past the provider'));
};

async function neverRekeys(): Promise<void> {
  const [agent, stored] = [await agentOf(world), secret()];
  const args = makeArgs(agent);

  expect((await runAct(world, { args, password: stored, at: crashPastProvider })).status).toBe(1);
  // Handed any other password, a rerun neither sets it on the user nor closes the act.
  const other = await runAct(world, { args, password: secret() });
  expect(other.printed).toContain('probe');
  expect(other.status).toBe(1);
  expect((await actsOf(world, agent)).map((act) => act['phase'])).toStrictEqual(['bound']);
  expect((await runAct(world, { args, password: stored })).status).toBe(0);
  await madeOnce(agent, stored);
  expect(puts()).toHaveLength(0);
}

async function twiceIsOnce(): Promise<void> {
  const [agent, password] = [await agentOf(world), secret()];
  const args = makeArgs(agent);
  expect((await runAct(world, { args, password })).status).toBe(0);
  const [before, calls] = [await actsOf(world, agent), world.provider.calls.length];
  const again = await runAct(world, { args, password });
  expect(again.printed).toContain('already made');
  expect(again.status).toBe(0);
  expect(await actsOf(world, agent)).toEqual(before);
  expect(world.provider.calls).toHaveLength(calls);
  expect(await mappingsOf(world, agent)).toHaveLength(1);
}

async function twoAtOnce(): Promise<void> {
  const [agent, password] = [await agentOf(world), secret()];
  const args = makeArgs(agent);
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
  const first = runAct(world, { args, password, at: hold });
  await Promise.race([atReserve, first]);
  const second = runAct(world, { args, password });
  // The second waits on the agent's lock while the first holds it.
  await Promise.race([waitingOnTheLock(world), second]);
  gates.release();
  expect((await Promise.all([first, second])).map((run) => run.status)).toStrictEqual([0, 0]);
  const act = await madeOnce(agent, password);
  expect(users.list.filter((user) => user.email === act['email'])).toHaveLength(1);
}

async function keepsSecrets(): Promise<void> {
  const password = secret();
  const inProcess = await runAct(world, {
    args: makeArgs(await agentOf(world), 'quiet@example.test'),
    password,
  });
  const agent = await agentOf(world);
  const command = await runCommand(world, makeArgs(agent, 'still@example.test'), password);
  expect(inProcess.status).toBe(0);
  expect(command.printed).toContain('made');
  expect(command.status).toBe(0);
  const stored = JSON.stringify(await actsOf(world, agent));
  for (const value of [password, ...world.secrets]) {
    for (const where of [inProcess.printed, command.printed, record(), stored])
      expect(where.includes(value)).toBe(false);
  }
  expect(`${inProcess.printed}${command.printed}${record()}`).not.toMatch(/quiet|still/u);
}

describe.skipIf(serverUrl === undefined)('agent login: make', () => {
  beforeAll(async () => {
    world = await makeWorld(serverUrl ?? '', users.handle);
    users.world = world;
  }, 60_000);
  afterAll(async () => await world?.close());

  it('make-binds-a-new-login-and-the-probe-answers-as-the-agent', bindsAndProbes, 60_000);
  it.each(['reserve', 'provider', 'reserved', 'user_made', 'bound'])(
    'make-resumes-after-a-crash-at-each-phase-with-the-stored-credential (%s)',
    resumes,
    60_000,
  );
  it('make-never-generates-a-second-credential', neverRekeys, 60_000);
  it('make-twice-changes-nothing', twiceIsOnce, 60_000);
  it('two-makes-at-once-leave-one-user-one-login-one-item', twoAtOnce, 60_000);
  it('no-act-prints-or-records-a-secret', keepsSecrets, 60_000);
});
