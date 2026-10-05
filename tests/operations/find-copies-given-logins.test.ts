// SPDX-License-Identifier: AGPL-3.0-only
//
// The copy finder's logins given back (scripts/privacy/find-copies.mjs): a
// login on a person's --id line is theirs or shared by who holds it now and
// who held it (docs/local/PRIVACY-RUNBOOK.md, 'Erasure').

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { serverUrl } from '../acceptance/world.ts';
import { findCopies } from './c81-privacy-runbook-finder.ts';
import { flagsFor, plantActingPerson, plantAgent, plantIssuedAgent } from './find-copies-agents.ts';

const test = it.skipIf(serverUrl === undefined);
let harness: Harness;
let adminUrl: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  harness = await createHarness('find_copies_logins');
  const url = new URL(process.env['DATABASE_ADMIN_URL'] ?? serverUrl);
  url.pathname = `/${harness.world.db.name}`;
  adminUrl = url.toString();
}, 120_000);

afterAll(async () => {
  await harness?.close();
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
