// SPDX-License-Identifier: AGPL-3.0-only
//
// The copy finder's shared agents (scripts/privacy/find-copies.mjs): an agent
// acting for more than one person stands for none of them, at the first
// search and at the search after an erasure (docs/local/PRIVACY-RUNBOOK.md).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { serverUrl } from '../acceptance/world.ts';
import { findCopies } from './c81-privacy-runbook-finder.ts';
import {
  plantActingPerson,
  plantAgent,
  plantAgentLogin,
  plantDelegation,
  plantGrant,
} from './find-copies-agents.ts';

const test = it.skipIf(serverUrl === undefined);
let harness: Harness;
let adminUrl: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  harness = await createHarness('find_copies_shared');
  const url = new URL(process.env['DATABASE_ADMIN_URL'] ?? serverUrl);
  url.pathname = `/${harness.world.db.name}`;
  adminUrl = url.toString();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

test('an agent acting for two people through delegations stands for neither, while each delegation stands for its own person', async () => {
  const { world } = harness;
  const ids = await world.db.app.withBusiness(world.alpha, async (tx) => {
    const a = await plantActingPerson(tx, 'Nell Twofold');
    const b = await plantActingPerson(tx, 'Otis Elsewhere');
    const agentG = await plantAgent(tx);
    return {
      personA: a.person,
      agentG,
      delegationA: await plantDelegation(tx, agentG, a.person, a.actor),
      delegationB: await plantDelegation(tx, agentG, b.person, b.actor),
      grantH: await plantGrant(tx, agentG, b.actor),
    };
  });

  const found = await findCopies(adminUrl, ['--text', 'Nell Twofold', '--export'], 'alpha');
  expect(found.code).toBe(0);
  const hit = (table: string, id: string) =>
    found.hits.find((each) => each.table === table && each.id === id);
  expect(hit('delegations', ids.delegationA)?.people).toContain(ids.personA);
  for (const [table, id] of [
    ['delegations', ids.delegationB],
    ['grants', ids.grantH],
    ['actors', ids.agentG],
  ] as const) {
    // A row naming the shared agent is listed for the owner to judge, as no one's.
    expect(hit(table, id)?.shared, `${table} names the shared agent`).toEqual([ids.agentG]);
    expect(hit(table, id)?.people, `${table} stands for no one`).toEqual([]);
  }
  expect(found.stderr).toContain(`agent ${ids.agentG} acts for ${ids.personA} and for others`);
  const searchAgain = found.stderr
    .split('\n')
    .find((line) => line.includes(`to search again for ${ids.personA} `));
  expect(searchAgain, "the person's own delegation is kept for the re-search").toContain(
    `--id ${ids.delegationA}`,
  );
  expect(searchAgain).not.toContain(ids.agentG);
});

test('after an erasure, an agent and its login given back, now acting for someone else too, mark no row given', async () => {
  const { world } = harness;
  const { a, agent, login, link, ownDelegation } = await world.db.app.withBusiness(
    world.alpha,
    async (tx) => {
      const person = await plantActingPerson(tx, 'Pia Handover');
      const linker = await plantActingPerson(tx, 'Vic Linker');
      const agentId = await plantAgent(tx);
      const delegation = await plantDelegation(tx, agentId, person.person, person.actor);
      const signIn = await plantAgentLogin(tx, agentId, linker.actor);
      return { a: person, agent: agentId, ownDelegation: delegation, ...signIn };
    },
  );
  const before = await findCopies(adminUrl, ['--text', 'Pia Handover'], 'alpha');
  const line = before.stderr
    .split('\n')
    .find((text) => text.includes(`search again for ${a.person} `));
  expect(line, 'the agent acts for the person alone, so it stands for them').toContain(
    `--id ${agent}`,
  );
  expect(line).toContain(`--id ${login}`);
  const flags = (line?.split('add: ')[1] ?? '').split(' ');

  // Another person takes over the agent's approvals; then the person is erased.
  const b = await world.db.app.withBusiness(world.alpha, async (tx) => {
    const taker = await plantActingPerson(tx, 'Quin Successor');
    const delegation = await plantDelegation(tx, agent, taker.person, taker.actor);
    return { ...taker, delegation, grant: await plantGrant(tx, agent, taker.actor) };
  });
  await world.db.admin.execute('delete from public.delegations where id = $1', [ownDelegation]);
  await world.db.admin.execute('delete from public.actors where id = $1', [a.actor]);
  await world.db.admin.execute('delete from public.people where id = $1', [a.person]);
  // The agent's sign-in is unlinked too: a login it held still says whose work it did.
  await world.db.admin.execute(
    'update public.actor_logins set active = false, deactivated_at = now() where id = $1',
    [link],
  );

  const after = await findCopies(adminUrl, ['--text', 'Pia Handover', ...flags], 'alpha');
  expect(after.code).toBe(0);
  expect(after.stderr).toContain(`${login}, given with --id, is shared`);
  for (const id of [b.grant, b.delegation, login, link]) {
    const hit = after.hits.find((each) => each.id === id);
    expect(hit?.shared.length, `${id} is listed as naming a shared agent`).toBeGreaterThan(0);
    expect(hit?.given, 'never a missed copy of the erased person').toBe(false);
  }
});

test('an agent acting only for two people one text names stands for neither of them', async () => {
  const { world } = harness;
  const { a, b, agent, grant } = await world.db.app.withBusiness(world.alpha, async (tx) => {
    const planted = {
      a: await plantActingPerson(tx, 'Wren Hollowmere'),
      b: await plantActingPerson(tx, 'Xavi Hollowmere'),
      agent: await plantAgent(tx),
      grant: randomUUID(),
    };
    await plantDelegation(tx, planted.agent, planted.a.person, planted.a.actor);
    await plantDelegation(tx, planted.agent, planted.b.person, planted.b.actor);
    await tx.query(
      `insert into public.grants
         (business_id, id, subject_kind, subject_id, scope_kind, collection, action, granted_by_actor_id)
       values ($1, $2, 'actor', $3, 'business', 'tasks', 'read', $4)`,
      [world.alpha, planted.grant, planted.agent, planted.b.actor],
    );
    return planted;
  });
  const found = await findCopies(adminUrl, ['--text', 'Hollowmere'], 'alpha');
  expect(found.code).toBe(0);
  const hit = found.hits.find((each) => each.table === 'grants' && each.id === grant);
  expect(hit?.shared, 'the grant names an agent acting for both').toEqual([agent]);
  expect(hit?.people, "the grant is neither person's by the agent").toEqual([b.person]);
  for (const person of [a.person, b.person]) {
    const line = found.stderr
      .split('\n')
      .find((text) => text.includes(`search again for ${person} `));
    expect(line).not.toContain(agent);
  }
});

test('an agent with a credential someone else issued stands for no one its delegations act for', async () => {
  const { world } = harness;
  const { a, agent } = await world.db.app.withBusiness(world.alpha, async (tx) => {
    const planted = {
      a: await plantActingPerson(tx, 'Rory Delegator'),
      issuer: await plantActingPerson(tx, 'Sage Issuer'),
      agent: await plantAgent(tx),
    };
    await tx.query(
      `insert into public.agent_credentials
         (business_id, id, agent_actor_id, issued_by_person_id, issued_by_actor_id, purpose, scope,
          credential_hash, credential_scheme, credential_key_id, expires_at)
       values ($1, $2, $3, $4, $5, 'triage', array['tasks:read'], $6, 'hmac-sha256-v1', 'k1',
               now() + interval '1 day')`,
      [
        world.alpha,
        randomUUID(),
        planted.agent,
        planted.issuer.person,
        planted.issuer.actor,
        'e'.repeat(64),
      ],
    );
    await plantDelegation(tx, planted.agent, planted.a.person, planted.a.actor);
    return planted;
  });
  const found = await findCopies(adminUrl, ['--text', 'Rory Delegator'], 'alpha');
  expect(found.code).toBe(0);
  const line = found.stderr
    .split('\n')
    .find((text) => text.includes(`search again for ${a.person} `));
  expect(line).not.toContain(agent);
  expect(found.hits.find((hit) => hit.table === 'actors' && hit.id === agent)?.people).toEqual([]);
});

test('an agent acting only for a person and someone merged with them stands for that person', async () => {
  const { world } = harness;
  const { a, agent } = await world.db.app.withBusiness(world.alpha, async (tx) => {
    const planted = {
      a: await plantActingPerson(tx, 'Tess Survivor'),
      b: await plantActingPerson(tx, 'Uma Absorbed'),
      agent: await plantAgent(tx),
    };
    await tx.query(
      `insert into public.person_merges
         (business_id, id, surviving_person_id, absorbed_person_id, decided_by_actor_id, evidence)
       values ($1, $2, $3, $4, $5, 'same person')`,
      [world.alpha, randomUUID(), planted.a.person, planted.b.person, planted.a.actor],
    );
    await plantDelegation(tx, planted.agent, planted.a.person, planted.a.actor);
    await plantDelegation(tx, planted.agent, planted.b.person, planted.b.actor);
    return planted;
  });
  const found = await findCopies(adminUrl, ['--text', 'Tess Survivor'], 'alpha');
  expect(found.code).toBe(0);
  const line = found.stderr
    .split('\n')
    .find((text) => text.includes(`search again for ${a.person} `));
  expect(line).toContain(`--id ${agent}`);
  expect(found.stderr).not.toContain('and for others');
});
