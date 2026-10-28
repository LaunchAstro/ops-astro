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
  openCast,
  person,
  runSeed,
  SEED,
  serverUrl,
  snapshot,
  taskId,
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
    const users = people.map((login) => ({
      ...login,
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
    const member = people.find((login) => login.email === 'mia@alpha.local');
    expect(maker?.name).toBe(member?.person);
  });
});

// S2309-1: a subject is unique only within its provider. Another provider's
// login carrying Ada's subject, mapped to Noah, while Ada's own mapping is
// off, is not Ada: the seed refuses before its first write.
describe.skipIf(serverUrl === undefined)('#2298 click-through seed, one provider', () => {
  let other: Cast;

  beforeAll(async () => {
    other = await openCast('ct2309provider');
  }, 300_000);

  afterAll(async () => {
    await closeWorld(other);
  });

  it("refuses another provider's login with Ada's subject, writing nothing", async () => {
    const [ada, noah] = [person(other, 'ada@alpha.local'), person(other, 'noah@alpha.local')];
    await other.db.app.withBusiness(other.business, async (tx) => {
      const [held] = await tx.query<{ person_id: string; actor_id: string }>(
        `select pl.person_id, a.id as actor_id from public.person_logins pl
           join public.logins l on l.business_id = pl.business_id and l.id = pl.login_id
           join public.actors a on a.business_id = pl.business_id and a.person_id = pl.person_id
          where pl.business_id = $1 and l.provider = 'supabase' and l.subject = $2 and pl.active`,
        [tx.businessId, noah.subject],
      );
      const login = randomUUID();
      await tx.query(
        `insert into public.logins (business_id, id, provider, subject)
         values ($1, $2, 'made-up-other', $3)`,
        [tx.businessId, login, ada.subject],
      );
      await tx.query(
        `insert into public.person_logins (business_id, id, login_id, person_id, linked_by_actor_id)
         values ($1, $2, $3, $4, $5)`,
        [tx.businessId, randomUUID(), login, held!.person_id, held!.actor_id],
      );
      await tx.query(
        `update public.person_logins pl set active = false, deactivated_at = clock_timestamp()
           from public.logins l
          where l.business_id = pl.business_id and l.id = pl.login_id and pl.business_id = $1
            and l.provider = 'supabase' and l.subject = $2`,
        [tx.businessId, ada.subject],
      );
    });
    const was = await snapshot(other.db);
    const refused = runSeed(SEED, { admin: other.db, local: other.local });
    expect(refused.status, refused.out).toBe(1);
    expect(refused.out).toMatch(/REFUSED, the cast of 'alpha' is not seeded/u);
    expect(await snapshot(other.db)).toEqual(was);
  });
});
