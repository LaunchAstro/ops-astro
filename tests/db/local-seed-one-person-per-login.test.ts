// SPDX-License-Identifier: AGPL-3.0-only
//
// #2417, #2426: the local seed run before auth:seed and again after it (the
// trial kits' order) keeps one person for each of the cast. The first run
// names its placeholder people; auth:seed then rewrites the users file with its
// own list; the second run finds each person by name. Two lists naming one
// made-up person differently gave mia, noah, bea and ben a second person with
// an active membership, so a grant written to the first one never reached the
// login the second run mapped.

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  openCast,
  runSeed,
  serverUrl,
  type Cast,
} from './click-through-seed.fixture.ts';

interface Login {
  readonly email: string;
  readonly businessKey: string;
  readonly person: string;
  readonly role: string;
}

interface User {
  readonly email: string;
  readonly subject: string;
}

// auth:seed's own list, by path: it is a plain script with no types.
const logins: string = resolve(import.meta.dirname, '../../scripts/local/synthetic-logins.mjs');

let cast: Cast;
let people: readonly Login[];
let firstMembers: readonly string[];
let firstPersonOf: ReadonlyMap<string, string>;
let secondRun: { readonly status: number | null; readonly out: string };

/** Every person holding an active membership, across both businesses. */
async function members(): Promise<readonly string[]> {
  const rows = await cast.db.admin.execute<{ person_id: string }>(
    `select m.person_id from public.memberships m where m.active order by m.person_id`,
  );
  return rows.map((row) => row.person_id);
}

/** The person each address's login is mapped to, read from the users file the seed was given. */
async function personOfLogins(): Promise<ReadonlyMap<string, string>> {
  const users = JSON.parse(
    readFileSync(join(cast.local, 'synthetic-users.json'), 'utf8'),
  ) as readonly User[];
  const mapped = new Map<string, string>();
  for (const user of users) {
    // oxlint-disable-next-line no-await-in-loop
    const [row] = await cast.db.admin.execute<{ person_id: string }>(
      `select pl.person_id from public.person_logins pl
         join public.logins l on l.business_id = pl.business_id and l.id = pl.login_id
        where l.provider = 'supabase' and l.subject = $1 and pl.active`,
      [user.subject],
    );
    if (row !== undefined) mapped.set(user.email, row.person_id);
  }
  return mapped;
}

describe.skipIf(serverUrl === undefined)(
  'the local seed, run before and after auth:seed, keeps one person per login',
  () => {
    beforeAll(async () => {
      ({ PEOPLE: people } = (await import(logins)) as { PEOPLE: readonly Login[] });
      // First run: no users file, so the seed writes its placeholders.
      cast = await openCast('ls2417oneperson');
      firstMembers = await members();
      firstPersonOf = await personOfLogins();
      // auth:seed: its own list, each with a new password and the provider's subject.
      const users = people.map((login) => ({
        ...login,
        password: `local-${randomUUID().slice(0, 12)}`,
        subject: randomUUID(),
        provider: 'supabase',
      }));
      writeFileSync(join(cast.local, 'synthetic-users.json'), JSON.stringify(users), {
        mode: 0o600,
      });
      // Second run: the seed again, on the file auth:seed wrote.
      secondRun = runSeed(join(cast.root, 'scripts/local-seed.mjs'), {
        admin: cast.db,
        local: cast.local,
        confirm: true,
      });
    }, 300_000);

    afterAll(async () => {
      await closeWorld(cast);
    });

    it('runs the second time', () => {
      expect(secondRun.status, secondRun.out).toBe(0);
    });

    it('adds no person with a membership on the second run', async () => {
      expect(await members()).toStrictEqual(firstMembers);
    });

    it("maps each of the cast's new logins to the person the first run made", async () => {
      const second = await personOfLogins();
      const emails = people.filter((login) => login.role !== 'none').map((login) => login.email);
      expect(emails.length).toBeGreaterThan(0);
      expect(emails.map((email) => second.get(email))).toStrictEqual(
        emails.map((email) => firstPersonOf.get(email)),
      );
    });
  },
);
