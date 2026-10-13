// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent login tool's make, up to its admission (scripts/ops/agent-login.ts):
// it refuses a person, an inactive agent, an agent whose owner left, an
// address another act holds, a subject another business's login holds, an
// agent of another business, a sign-in service of another project, production
// without the flag and an agent at the door. An operator who loses the grant
// or the session, or an owner who leaves, while the make waits on the agent's
// lock stops it before any write or provider call.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { signBearer } from '../support/sign-in.ts';
import {
  actsOf,
  agentOf,
  holdingTheAgent,
  makeArgs,
  makeWorld,
  mappingsOf,
  PRODUCTION,
  runAct,
  toolPresent,
  type World,
} from './agent-login.fixture.ts';
import { POOLER, projectRef } from './production-bootstrap.fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
// The pooler's name reaches this server on loopback, as in the command's own process.
await import(new URL('../support/pooler-at-loopback.mjs', import.meta.url).href);
Reflect.set(globalThis, Symbol.for('ops-astro.test.plaintext-at-loopback'), true);

let world: World;
type Case = { args: string[]; env?: Record<string, string> };
const POOLED = `${POOLER}:5432/postgres?sslmode=require`;

/** A person of `business` with no membership and no person actor: an owner who left. */
async function leftOwner(business: string): Promise<string> {
  const [row] = await world.db.admin.execute<{ id: string }>(
    `insert into public.people (business_id, id, display_name)
     values ($1, gen_random_uuid(), 'Gus') returning id`,
    [business],
  );
  return row?.id ?? '';
}

/** An act of `agent`'s, planted as an earlier run left it. */
async function plantAct(agent: string, email: string, subject: string | null): Promise<void> {
  await world.db.admin.execute(
    `insert into ops.agent_login_acts (business_id, agent_actor_id, act, generation, email,
       custody_item, provider_subject, phase, operator_person_id)
     values ($1, $2, 'make', 1, $3, 'item', $4, $5, $6)`,
    [
      world.alpha,
      agent,
      email,
      subject,
      subject === null ? 'reserved' : 'user_made',
      world.operatorPerson,
    ],
  );
}

/** An agent of alpha's signed in at the door: its bearer stands in for the operator's. */
async function agentBearer(): Promise<string> {
  const subject = randomUUID();
  await world.db.admin.execute(
    `with l as (insert into public.logins (business_id, id, provider, subject)
                values ($1, gen_random_uuid(), 'supabase', $2) returning id)
     insert into public.actor_logins (business_id, id, login_id, actor_id, active, linked_by_actor_id)
     select $1, gen_random_uuid(), l.id, $3, true, $4 from l`,
    [world.alpha, subject, await agentOf(world), world.ownerActor],
  );
  const claims = { sub: subject, aud: 'authenticated', iss: world.env['GOTRUE_URL'] };
  return await signBearer({ ...claims, role: 'authenticated', exp: Date.now() / 1000 + 600 });
}

const OTHER_SIGN_IN = `https://${projectRef()}.supabase.co/auth/v1`;
const SET_UP: Record<string, (agent: string) => Case | Promise<Case>> = {
  'a-person-actor': () => ({ args: makeArgs(world.ownerActor) }),
  'an-inactive-agent': async () => ({ args: makeArgs(await agentOf(world, { active: false })) }),
  'an-agent-whose-owner-left': async () => {
    const owner = await leftOwner(world.alpha);
    return { args: makeArgs(await agentOf(world, { owner })) };
  },
  'an-email-used-by-another-act': async (agent) => {
    await plantAct(await agentOf(world), 'taken+g1@example.test', null);
    return { args: makeArgs(agent, 'taken@example.test') };
  },
  'a-subject-mapped-elsewhere': async (agent) => {
    const subject = randomUUID();
    await world.db.admin.execute(
      `insert into public.logins (business_id, id, provider, subject)
       values ($1, gen_random_uuid(), 'supabase', $2)`,
      [world.beta, subject],
    );
    await plantAct(agent, 'mapped+g1@example.test', subject);
    return { args: makeArgs(agent, 'mapped@example.test') };
  },
  "a-business-other-than-the-operator's": async () => {
    const owner = await leftOwner(world.beta);
    return { args: makeArgs(await agentOf(world, { business: world.beta, owner })) };
  },
  'a-sign-in-service-of-another-project': (agent) => ({
    args: makeArgs(agent),
    env: { GOTRUE_URL: OTHER_SIGN_IN },
  }),
  'production-without-the-flag': (agent) => ({
    args: makeArgs(agent),
    env: { DATABASE_ADMIN_URL: `postgresql://postgres.${PRODUCTION}:pw@${POOLED}` },
  }),
  'an-agent-at-the-door': async (agent) => ({
    args: makeArgs(agent),
    env: { OPS_ASTRO_TOKEN: await agentBearer() },
  }),
};
const WORDS: Record<string, string> = {
  'a-person-actor': 'not an agent',
  'an-inactive-agent': 'not active',
  'an-agent-whose-owner-left': 'owner',
  'an-email-used-by-another-act': 'address',
  'a-subject-mapped-elsewhere': 'already a login',
  "a-business-other-than-the-operator's": 'not an agent of',
  'a-sign-in-service-of-another-project': 'GOTRUE_URL',
  'production-without-the-flag': "production's project",
  'an-agent-at-the-door': 'refused',
};

async function refuses(name: string): Promise<void> {
  toolPresent();
  const { args, env } = await SET_UP[name]!(await agentOf(world));
  const [target = '', calls] = [args[2], world.provider.calls.length];
  const before = await actsOf(world, target);
  const refused = await runAct(world, { args, ...(env === undefined ? {} : { env }) });
  expect(refused.printed).toContain(WORDS[name]);
  expect(refused.status).toBe(1);
  expect(await mappingsOf(world, target)).toHaveLength(0);
  expect(await actsOf(world, target), name).toEqual(before);
  expect(world.provider.calls).toHaveLength(calls);
}

const LOST: [string, string, () => string, string][] = [
  [
    'operator-grant-revoked-during-a-wait-stops-the-act-before-any-write-or-provider-call',
    "update public.grants set revoked_at = now() where subject_id = $1 and collection = 'operations'",
    () => world.operatorPerson,
    'no longer the operator',
  ],
  [
    'operator-session-ended-during-a-wait-stops-the-act-before-any-write-or-provider-call',
    'insert into ops.ended_provider_sessions (session_id) values ($1)',
    () => world.operatorSession,
    'no longer the operator',
  ],
  [
    'agent-owner-left-during-a-wait-stops-the-act-before-any-write-or-provider-call',
    'update public.memberships set active = false, ended_at = now() where person_id = $1',
    () => world.ownerPerson,
    'owner',
  ],
];

async function stopsAfterTheWait(statement: string, id: string, words: string) {
  const agent = await agentOf(world);
  const calls = world.provider.calls.length;
  const lose = async (): Promise<void> => {
    await world.db.admin.execute(statement, [id]);
  };
  const make = async () => await runAct(world, { args: makeArgs(agent) });
  const result = await holdingTheAgent(world, agent, lose, make);
  expect(result.printed).toContain(words);
  expect(result.status).toBe(1);
  expect(await actsOf(world, agent)).toHaveLength(0);
  expect(world.provider.calls).toHaveLength(calls);
}

/** The grant, the session and the owner as they were before a case took one away. */
async function putBack(): Promise<void> {
  const { admin } = world.db;
  await admin.execute('update public.grants set revoked_at = null where subject_id = $1', [
    world.operatorPerson,
  ]);
  await admin.execute('delete from ops.ended_provider_sessions where session_id = $1', [
    world.operatorSession,
  ]);
  await admin.execute(
    'update public.memberships set active = true, ended_at = null where person_id = $1',
    [world.ownerPerson],
  );
}

describe.skipIf(serverUrl === undefined)('agent login: make admission', () => {
  beforeAll(async () => {
    world = await makeWorld(serverUrl ?? '');
  }, 60_000);
  afterAll(async () => await world?.close());

  it.each(Object.keys(SET_UP))('make-refuses-%s', refuses, 30_000);

  it.each(LOST)(
    '%s',
    async (_name, statement, id, words) => {
      try {
        await stopsAfterTheWait(statement, id(), words);
      } finally {
        await putBack();
      }
    },
    60_000,
  );
});
