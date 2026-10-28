// SPDX-License-Identifier: AGPL-3.0-only
//
// #2298: the click-through seed finds its cast by sign-in address, so it runs
// after the documented order (auth:seed, then db:seed), whose people carry
// auth:seed's names rather than local-seed's placeholders.

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  runSeed,
  SEED,
  serverUrl,
  taskId,
  openCast,
  type Cast,
  type Ran,
} from './click-through-seed.fixture.ts';

interface Login {
  readonly email: string;
  readonly person: string;
}

// auth:seed's own list, by path: it is a plain script with no types.
const logins: string = resolve(import.meta.dirname, '../../scripts/local/synthetic-logins.mjs');

let people: readonly Login[];
let cast: Cast;
let ran: Ran;

describe.skipIf(serverUrl === undefined)('#2298 click-through seed after auth:seed', () => {
  beforeAll(async () => {
    ({ PEOPLE: people } = (await import(logins)) as { PEOPLE: readonly Login[] });
    // The file auth:seed writes: its people, each with a password and subject.
    const users = people.map((person) => ({
      ...person,
      password: `local-${randomUUID().slice(0, 12)}`,
      subject: randomUUID(),
      provider: 'supabase',
    }));
    cast = await openCast('ct2298authseed', users);
    ran = runSeed(SEED, { admin: cast.db, local: cast.local });
  }, 300_000);

  afterAll(async () => {
    await closeWorld(cast);
  });

  it("runs on db:seed's cast when auth:seed named the people", () => {
    expect(ran.status, ran.out).toBe(0);
  });

  it("makes the member's tasks as auth:seed's member", async () => {
    const id = await taskId(cast, 'Book the team photo shoot');
    const [maker] = await cast.db.admin.execute<{ name: string }>(
      `select p.display_name as name from public.audit_events e
         join public.actors a on a.business_id = e.business_id and a.id = e.actor_id
         join public.people p on p.business_id = a.business_id and p.id = a.person_id
        where e.subject_record_id = $1 and e.command = 'task.create' and e.outcome = 'applied'`,
      [id],
    );
    const member = people.find((person) => person.email === 'mia@alpha.local');
    expect(maker?.name).toBe(member?.person);
  });
});
