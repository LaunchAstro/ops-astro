// SPDX-License-Identifier: AGPL-3.0-only
//
// Review FIX-2A (RP): find-copies follows the person's own id one hop only.
// Rows naming the person by their login or their acting id, and rows left
// naming an erased person's id, are never listed.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { serverUrl } from '../acceptance/world.ts';
import { findCopies } from './c81-privacy-runbook-finder.ts';

const test = it.skipIf(serverUrl === undefined);
let harness: Harness;
let adminUrl: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  harness = await createHarness('rev_rp_finder');
  const url = new URL(process.env['DATABASE_ADMIN_URL'] ?? serverUrl);
  url.pathname = `/${harness.world.db.name}`;
  adminUrl = url.toString();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

/** A person with an acting identity and a sign-in; answers the ids. */
async function plantSignedInPerson(name: string) {
  const { world } = harness;
  const ids = {
    person: randomUUID(),
    actor: randomUUID(),
    login: randomUUID(),
    link: randomUUID(),
    grant: randomUUID(),
  };
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await tx.query(
      `insert into public.people (business_id, id, display_name) values ($1, $2, $3)`,
      [world.alpha, ids.person, name],
    );
    await tx.query(
      `insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'person', $3)`,
      [world.alpha, ids.actor, ids.person],
    );
    await tx.query(
      `insert into public.logins (business_id, id, provider, subject) values ($1, $2, 'dry-run', $3)`,
      [world.alpha, ids.login, `sub-${randomUUID()}`],
    );
    await tx.query(
      `insert into public.person_logins (business_id, id, login_id, person_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [world.alpha, ids.link, ids.login, ids.person, ids.actor],
    );
    await tx.query(
      `insert into public.grants
         (business_id, id, subject_kind, subject_id, scope_kind, collection, action, granted_by_actor_id)
       values ($1, $2, 'actor', $3, 'business', 'tasks', 'read', $3)`,
      [world.alpha, ids.grant, ids.actor],
    );
  });
  return ids;
}

test('RP-1a find-copies lists the login row of a person found by name', async () => {
  const name = `qx7login${randomUUID().slice(0, 8)}`;
  const ids = await plantSignedInPerson(`Sam ${name}`);
  const found = await findCopies(adminUrl, ['--text', name], 'alpha');
  expect(found.code).toBe(0);
  const pairs = found.hits.map((hit) => [hit.table, hit.id]);
  expect(pairs, 'the person_logins link is found (one hop)').toContainEqual([
    'person_logins',
    ids.link,
  ]);
  expect(pairs, 'the logins row holding their sign-in subject').toContainEqual([
    'logins',
    ids.login,
  ]);
});

test('RP-1b find-copies lists a grant held by the person acting', async () => {
  const name = `qx7actor${randomUUID().slice(0, 8)}`;
  const ids = await plantSignedInPerson(`Lee ${name}`);
  const found = await findCopies(adminUrl, ['--text', name], 'alpha');
  expect(found.hits.map((hit) => [hit.table, hit.id])).toContainEqual(['grants', ids.grant]);
});

test('RP-1d find-copies by the email a person wrote from lists their membership', async () => {
  const { world } = harness;
  const mail = `qx7mail${randomUUID().slice(0, 8)}@example.test`;
  const person = randomUUID();
  const membership = randomUUID();
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await tx.query(
      `insert into public.people (business_id, id, display_name) values ($1, $2, 'Alex Doe')`,
      [world.alpha, person],
    );
    await tx.query(
      `insert into public.person_identifiers
         (business_id, id, person_id, kind, value, observed_value, source_system)
       values ($1, $2, $3, 'email', $4, $4, 'dry-run')`,
      [world.alpha, randomUUID(), person, mail],
    );
    await tx.query(
      `insert into public.memberships (business_id, id, person_id, role_key) values ($1, $2, $3, 'staff')`,
      [world.alpha, membership, person],
    );
  });
  const found = await findCopies(adminUrl, ['--text', mail], 'alpha');
  const pairs = found.hits.map((hit) => [hit.table, hit.id]);
  expect(
    pairs.map(([table]) => table),
    'the identifier row is found',
  ).toContain('person_identifiers');
  expect(pairs, 'their membership').toContainEqual(['memberships', membership]);
});

test('RD-2 find-copies lists a row naming only the agent of a credential the person issued', async () => {
  const { world } = harness;
  const name = `qx7agent${randomUUID().slice(0, 8)}`;
  const ids = await plantSignedInPerson(`Kim ${name}`);
  const agent = randomUUID();
  const agentGrant = randomUUID();
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await tx.query(
      `insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'agent', null)`,
      [world.alpha, agent],
    );
    await tx.query(
      `insert into public.agent_credentials
         (business_id, id, agent_actor_id, issued_by_person_id, issued_by_actor_id, purpose, scope,
          credential_hash, credential_scheme, credential_key_id, expires_at)
       values ($1, $2, $3, $4, $5, 'triage', array['tasks:read'], $6, 'hmac-sha256-v1', 'k1',
               now() + interval '1 day')`,
      [world.alpha, randomUUID(), agent, ids.person, ids.actor, 'a'.repeat(64)],
    );
    await tx.query(
      `insert into public.grants
         (business_id, id, subject_kind, subject_id, scope_kind, collection, action, granted_by_actor_id)
       values ($1, $2, 'actor', $3, 'business', 'tasks', 'read', $3)`,
      [world.alpha, agentGrant, agent],
    );
  });
  const found = await findCopies(adminUrl, ['--text', name], 'alpha');
  expect(found.hits.map((hit) => [hit.table, hit.id])).toContainEqual(['grants', agentGrant]);
});

test('find-copies lists the agent acting for a person through a delegation, and a grant naming that agent alone', async () => {
  const { world } = harness;
  const ids = {
    personA: randomUUID(),
    actorPA: randomUUID(),
    personB: randomUUID(),
    actorPB: randomUUID(),
    agentG: randomUUID(),
    delegationD: randomUUID(),
    grantH: randomUUID(),
  };
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await tx.query(
      `insert into public.people (business_id, id, display_name) values ($1, $2, 'Rhea Delegate')`,
      [world.alpha, ids.personA],
    );
    await tx.query(
      `insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'person', $3)`,
      [world.alpha, ids.actorPA, ids.personA],
    );
    await tx.query(
      `insert into public.people (business_id, id, display_name) values ($1, $2, 'Otto Unrelated')`,
      [world.alpha, ids.personB],
    );
    await tx.query(
      `insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'person', $3)`,
      [world.alpha, ids.actorPB, ids.personB],
    );
    await tx.query(
      `insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'agent', null)`,
      [world.alpha, ids.agentG],
    );
    await tx.query(
      `insert into public.delegations
         (business_id, id, agent_actor_id, delegate_person_id, minted_by_actor_id, purpose,
          collections, actions, credential_hash, expires_at, purpose_scope_kind, purpose_scope_id)
       values ($1, $2, $3, $4, $5, 'triage', array['tasks'], array['read'], $6,
               now() + interval '1 day', 'record', $7)`,
      [
        world.alpha,
        ids.delegationD,
        ids.agentG,
        ids.personA,
        ids.actorPA,
        'b'.repeat(64),
        randomUUID(),
      ],
    );
    await tx.query(
      `insert into public.grants
         (business_id, id, subject_kind, subject_id, scope_kind, collection, action, granted_by_actor_id)
       values ($1, $2, 'actor', $3, 'business', 'tasks', 'read', $4)`,
      [world.alpha, ids.grantH, ids.agentG, ids.actorPB],
    );
  });

  const found = await findCopies(adminUrl, ['--text', 'Rhea Delegate', '--export'], 'alpha');
  expect(found.code).toBe(0);
  const hit = (table: string, id: string) =>
    found.hits.find((each) => each.table === table && each.id === id);

  // The delegation itself is found through A's own ids (the Scenario's Actual).
  expect(hit('delegations', ids.delegationD)?.people).toContain(ids.personA);

  // Expected: the agent acting for A and the grant naming that agent alone are
  // copies attributed to A, and the agent's id is in A's re-search flags.
  expect(hit('actors', ids.agentG), 'agent G is listed').toBeDefined();
  expect(hit('actors', ids.agentG)?.people, 'agent G is a copy attributed to A').toContain(
    ids.personA,
  );
  expect(hit('grants', ids.grantH)?.people, 'grant H is a copy attributed to A').toContain(
    ids.personA,
  );
  const searchAgain = found.stderr
    .split('\n')
    .find((line) => line.includes(`to search again for ${ids.personA} `));
  expect(searchAgain, "A's re-search flags carry G").toContain(`--id ${ids.agentG}`);
});

test('the login an issued agent signs in with is found, and its id kept for the search after an erasure', async () => {
  const { world } = harness;
  const ids = {
    person: randomUUID(),
    actor: randomUUID(),
    agent: randomUUID(),
    credential: randomUUID(),
    login: randomUUID(),
    link: randomUUID(),
  };
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    await tx.query(
      `insert into public.people (business_id, id, display_name) values ($1, $2, 'Kit Issuer')`,
      [world.alpha, ids.person],
    );
    await tx.query(
      `insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'person', $3)`,
      [world.alpha, ids.actor, ids.person],
    );
    await tx.query(
      `insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'agent', null)`,
      [world.alpha, ids.agent],
    );
    await tx.query(
      `insert into public.agent_credentials
         (business_id, id, agent_actor_id, issued_by_person_id, issued_by_actor_id, purpose, scope,
          credential_hash, credential_scheme, credential_key_id, expires_at)
       values ($1, $2, $3, $4, $5, 'triage', array['tasks:read'], $6, 'hmac-sha256-v1', 'k1',
               now() + interval '1 day')`,
      [world.alpha, ids.credential, ids.agent, ids.person, ids.actor, 'a'.repeat(64)],
    );
    await tx.query(
      `insert into public.logins (business_id, id, provider, subject) values ($1, $2, 'dry-run', $3)`,
      [world.alpha, ids.login, `opaque-${randomUUID()}`],
    );
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [world.alpha, ids.link, ids.login, ids.agent, ids.actor],
    );
  });

  const found = await findCopies(adminUrl, ['--text', 'Kit Issuer', '--export'], 'alpha');
  expect(found.code).toBe(0);
  const pairs = found.hits.map((hit) => [hit.table, hit.id]);
  // Setup sanity: the agent and its sign-in mapping are found.
  expect(pairs, 'the agent actor is found').toContainEqual(['actors', ids.agent]);
  expect(pairs, 'the actor_logins mapping is found').toContainEqual(['actor_logins', ids.link]);

  // Expected: the agent's own sign-in row, attributed to the issuing person.
  const login = found.hits.find((hit) => hit.table === 'logins' && hit.id === ids.login);
  expect(login, "the issued agent's logins row is listed").toBeDefined();
  expect(login?.people, 'attributed to the issuing person').toContain(ids.person);

  // Expected: its id is kept among the person's --id flags for the re-search.
  const line = found.stderr
    .split('\n')
    .find((text) => text.includes(`to search again for ${ids.person} `));
  expect(line, "the issuing person's re-search line").toBeDefined();
  expect(line, "the agent's login id is among the --id flags").toContain(`--id ${ids.login}`);
});

test('an agent acting for two people through delegations stands for neither, while each delegation stands for its own person', async () => {
  const { world } = harness;
  const ids = {
    personA: randomUUID(),
    actorPA: randomUUID(),
    personB: randomUUID(),
    actorPB: randomUUID(),
    agentG: randomUUID(),
    delegationA: randomUUID(),
    delegationB: randomUUID(),
    grantH: randomUUID(),
  };
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    for (const [person, actor, name] of [
      [ids.personA, ids.actorPA, 'Nell Twofold'],
      [ids.personB, ids.actorPB, 'Otis Elsewhere'],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await tx.query(
        `insert into public.people (business_id, id, display_name) values ($1, $2, $3)`,
        [world.alpha, person, name],
      );
      // oxlint-disable-next-line no-await-in-loop
      await tx.query(
        `insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'person', $3)`,
        [world.alpha, actor, person],
      );
    }
    await tx.query(
      `insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'agent', null)`,
      [world.alpha, ids.agentG],
    );
    for (const [delegation, person, actor, purpose] of [
      [ids.delegationA, ids.personA, ids.actorPA, 'triage'],
      [ids.delegationB, ids.personB, ids.actorPB, 'review'],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await tx.query(
        `insert into public.delegations
           (business_id, id, agent_actor_id, delegate_person_id, minted_by_actor_id, purpose,
            collections, actions, credential_hash, expires_at, purpose_scope_kind, purpose_scope_id)
         values ($1, $2, $3, $4, $5, $6, array['tasks'], array['read'], $7,
                 now() + interval '1 day', 'record', $8)`,
        [world.alpha, delegation, ids.agentG, person, actor, purpose, 'c'.repeat(64), randomUUID()],
      );
    }
    await tx.query(
      `insert into public.grants
         (business_id, id, subject_kind, subject_id, scope_kind, collection, action, granted_by_actor_id)
       values ($1, $2, 'actor', $3, 'business', 'tasks', 'read', $4)`,
      [world.alpha, ids.grantH, ids.agentG, ids.actorPB],
    );
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

/** A person with an acting identity, in business alpha. */
async function plantActingPerson(tx: Query, name: string) {
  const person = randomUUID();
  const actor = randomUUID();
  await tx.query(`insert into public.people (business_id, id, display_name) values ($1, $2, $3)`, [
    harness.world.alpha,
    person,
    name,
  ]);
  await tx.query(
    `insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'person', $3)`,
    [harness.world.alpha, actor, person],
  );
  return { person, actor };
}

/** A delegation of `agent` acting for `person`, minted by `actor`; answers its id. */
async function plantDelegation(tx: Query, agent: string, person: string, actor: string) {
  const id = randomUUID();
  await tx.query(
    `insert into public.delegations
       (business_id, id, agent_actor_id, delegate_person_id, minted_by_actor_id, purpose,
        collections, actions, credential_hash, expires_at, purpose_scope_kind, purpose_scope_id)
     values ($1, $2, $3, $4, $5, $6, array['tasks'], array['read'], $7,
             now() + interval '1 day', 'record', $8)`,
    [
      harness.world.alpha,
      id,
      agent,
      person,
      actor,
      `p${id.slice(0, 8)}`,
      'd'.repeat(64),
      randomUUID(),
    ],
  );
  return id;
}

async function plantAgent(tx: Query) {
  const agent = randomUUID();
  await tx.query(
    `insert into public.actors (business_id, id, kind, person_id) values ($1, $2, 'agent', null)`,
    [harness.world.alpha, agent],
  );
  return agent;
}

type Query = Parameters<Parameters<Harness['world']['db']['app']['withBusiness']>[1]>[0];

test('after an erasure, an agent and its login given back, now acting for someone else too, mark no row given', async () => {
  const { world } = harness;
  const { a, agent, grant, login, link, ownDelegation } = await world.db.app.withBusiness(
    world.alpha,
    async (tx) => {
      const planted = {
        a: await plantActingPerson(tx, 'Pia Handover'),
        linker: await plantActingPerson(tx, 'Vic Linker'),
        agent: await plantAgent(tx),
        grant: randomUUID(),
        login: randomUUID(),
        link: randomUUID(),
      };
      const delegation = await plantDelegation(
        tx,
        planted.agent,
        planted.a.person,
        planted.a.actor,
      );
      await tx.query(
        `insert into public.logins (business_id, id, provider, subject) values ($1, $2, 'dry-run', $3)`,
        [world.alpha, planted.login, `opaque-${randomUUID()}`],
      );
      await tx.query(
        `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
         values ($1, $2, $3, $4, $5)`,
        [world.alpha, planted.link, planted.login, planted.agent, planted.linker.actor],
      );
      return { ...planted, ownDelegation: delegation };
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
    await tx.query(
      `insert into public.grants
         (business_id, id, subject_kind, subject_id, scope_kind, collection, action, granted_by_actor_id)
       values ($1, $2, 'actor', $3, 'business', 'tasks', 'read', $4)`,
      [world.alpha, grant, agent, taker.actor],
    );
    return { ...taker, delegation };
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
  for (const id of [grant, b.delegation, login, link]) {
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

test("a login moved from another agent to the person's own one stays theirs when given back", async () => {
  const { world } = harness;
  const { a, login } = await world.db.app.withBusiness(world.alpha, async (tx) => {
    const planted = {
      a: await plantActingPerson(tx, 'Yara Keeper'),
      own: await plantAgent(tx),
      before: await plantAgent(tx),
      login: randomUUID(),
    };
    await tx.query(
      `insert into public.agent_credentials
         (business_id, id, agent_actor_id, issued_by_person_id, issued_by_actor_id, purpose, scope,
          credential_hash, credential_scheme, credential_key_id, expires_at)
       values ($1, $2, $3, $4, $5, 'triage', array['tasks:read'], $6, 'hmac-sha256-v1', 'k1',
               now() + interval '1 day')`,
      [world.alpha, randomUUID(), planted.own, planted.a.person, planted.a.actor, 'f'.repeat(64)],
    );
    await tx.query(
      `insert into public.logins (business_id, id, provider, subject) values ($1, $2, 'dry-run', $3)`,
      [world.alpha, planted.login, `opaque-${randomUUID()}`],
    );
    for (const [agent, active] of [
      [planted.before, false],
      [planted.own, true],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await tx.query(
        `insert into public.actor_logins
           (business_id, id, login_id, actor_id, linked_by_actor_id, active, deactivated_at)
         values ($1, $2, $3, $4, $5, $6, case when $6 then null else now() end)`,
        [world.alpha, randomUUID(), planted.login, agent, planted.a.actor, active],
      );
    }
    return planted;
  });
  const first = await findCopies(adminUrl, ['--text', 'Yara Keeper'], 'alpha');
  const line = first.stderr
    .split('\n')
    .find((text) => text.includes(`search again for ${a.person} `));
  expect(line).toContain(`--id ${login}`);
  const again = await findCopies(
    adminUrl,
    ['--text', 'Yara Keeper', ...(line?.split('add: ')[1] ?? '').split(' ')],
    'alpha',
  );
  const hit = again.hits.find((each) => each.table === 'logins' && each.id === login);
  expect(hit?.shared, 'the login is held by the agent standing for the person').toEqual([]);
  expect(hit?.given).toBe(true);
});

/** An agent of a credential `issuer` issued; answers the agent. */
async function plantIssuedAgent(tx: Query, issuer: { person: string; actor: string }) {
  const agent = await plantAgent(tx);
  await tx.query(
    `insert into public.agent_credentials
       (business_id, id, agent_actor_id, issued_by_person_id, issued_by_actor_id, purpose, scope,
        credential_hash, credential_scheme, credential_key_id, expires_at)
     values ($1, $2, $3, $4, $5, 'triage', array['tasks:read'], $6, 'hmac-sha256-v1', 'k1',
             now() + interval '1 day')`,
    [harness.world.alpha, randomUUID(), agent, issuer.person, issuer.actor, '9'.repeat(64)],
  );
  return agent;
}

/** The --id flags the finder printed for `person`. */
function flagsFor(stderr: string, person: string): string[] {
  const line = stderr.split('\n').find((text) => text.includes(`search again for ${person} `));
  return (line?.split('add: ')[1] ?? '').split(' ').filter((part) => part !== '');
}

test("a login given back, now held by the agent of a namesake, is shared, not the person's", async () => {
  const { world } = harness;
  const { a, login, link } = await world.db.app.withBusiness(world.alpha, async (tx) => {
    const person = await plantActingPerson(tx, 'Zed Namesake');
    const own = await plantIssuedAgent(tx, person);
    const planted = { a: person, login: randomUUID(), link: randomUUID() };
    await tx.query(
      `insert into public.logins (business_id, id, provider, subject) values ($1, $2, 'dry-run', $3)`,
      [world.alpha, planted.login, `opaque-${randomUUID()}`],
    );
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [world.alpha, planted.link, planted.login, own, person.actor],
    );
    return planted;
  });
  const flags = flagsFor(
    (await findCopies(adminUrl, ['--text', 'Zed Namesake'], 'alpha')).stderr,
    a.person,
  );
  expect(flags).toContain(login);

  // Another person of the same name, whose agent now holds the login.
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    const namesake = await plantActingPerson(tx, 'Zed Namesake');
    const theirs = await plantIssuedAgent(tx, namesake);
    await tx.query(
      'update public.actor_logins set active = false, deactivated_at = now() where id = $1',
      [link],
    );
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [world.alpha, randomUUID(), login, theirs, namesake.actor],
    );
  });
  const again = await findCopies(adminUrl, ['--text', 'Zed Namesake', ...flags], 'alpha');
  const hit = again.hits.find((each) => each.table === 'logins' && each.id === login);
  expect(hit?.shared, "the namesake's agent holds it now").toEqual([login]);
  expect(hit?.given).toBe(false);
});

test('a login given back that the person now holds themselves stays theirs', async () => {
  const { world } = harness;
  const { a, login, link } = await world.db.app.withBusiness(world.alpha, async (tx) => {
    const person = await plantActingPerson(tx, 'Ada Selfheld');
    const own = await plantIssuedAgent(tx, person);
    const planted = { a: person, login: randomUUID(), link: randomUUID() };
    await tx.query(
      `insert into public.logins (business_id, id, provider, subject) values ($1, $2, 'dry-run', $3)`,
      [world.alpha, planted.login, `opaque-${randomUUID()}`],
    );
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [world.alpha, planted.link, planted.login, own, person.actor],
    );
    return planted;
  });
  const flags = flagsFor(
    (await findCopies(adminUrl, ['--text', 'Ada Selfheld'], 'alpha')).stderr,
    a.person,
  );
  expect(flags).toContain(login);

  // The login moves from an agent the person no longer uses to the person.
  await world.db.app.withBusiness(world.alpha, async (tx) => {
    const stranger = await plantActingPerson(tx, 'Bo Stranger');
    const theirs = await plantIssuedAgent(tx, stranger);
    await tx.query(
      'update public.actor_logins set active = false, deactivated_at = now() where id = $1',
      [link],
    );
    await tx.query(
      `insert into public.actor_logins
         (business_id, id, login_id, actor_id, linked_by_actor_id, active, deactivated_at)
       values ($1, $2, $3, $4, $5, false, now())`,
      [world.alpha, randomUUID(), login, theirs, stranger.actor],
    );
    await tx.query(
      `insert into public.person_logins (business_id, id, login_id, person_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [world.alpha, randomUUID(), login, a.person, a.actor],
    );
  });
  const again = await findCopies(adminUrl, ['--text', 'Ada Selfheld', ...flags], 'alpha');
  const hit = again.hits.find((each) => each.table === 'logins' && each.id === login);
  expect(hit?.shared, 'the person holds it now').toEqual([]);
  expect(hit?.given).toBe(true);
});
