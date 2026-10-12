// SPDX-License-Identifier: AGPL-3.0-only
//
// Two times a record keeps as history, held by the database against the
// application role's own update grant: when a privacy incident was found,
// which the 30-day assessment limit runs from (0050), and when an agent
// credential was revoked, which the database stamps rather than taking the
// writer's time (0054, as standing mandates do).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, type Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('times written once', () => {
  let db: FreshDatabase;
  let business: string;
  let person: Member;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'writtenonce' });
    business = await insertBusiness(db.app, 'written-once');
    person = await enrol(db.app, business, 'recorder');
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  const asApp = async (sql: string, params: readonly unknown[]) =>
    await db.app.withBusiness(business, async (tx) => await tx.query(sql, params));

  it('refuses a change to when a privacy incident was found, and still moves its status', async () => {
    const id = randomUUID();
    await asApp(
      `insert into public.privacy_incidents
         (business_id, id, what_happened, found_at, found_by, affected, information_kinds,
          recorded_by_actor)
       values ($1, $2, 'a report went to the wrong client', now() - interval '2 days',
               'the account manager', 'one client', array['contact'], $3)`,
      [business, id, person.actorId],
    );
    const [before] = await db.admin.execute<{ readonly found: string }>(
      `select found_at::text as found from public.privacy_incidents where id = $1`,
      [id],
    );

    await expect(
      asApp(`update public.privacy_incidents set found_at = now() where id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23001' });
    await asApp(`update public.privacy_incidents set status = 'closed' where id = $1`, [id]);

    const [after] = await db.admin.execute<{ readonly found: string; readonly status: string }>(
      `select found_at::text as found, status from public.privacy_incidents where id = $1`,
      [id],
    );
    expect(after).toStrictEqual({ found: before?.found, status: 'closed' });
  });

  it('stamps an agent credential revocation with the database clock, not the time sent', async () => {
    const id = randomUUID();
    const agent = randomUUID();
    await asApp(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      business,
      agent,
    ]);
    await asApp(
      `insert into public.agent_credentials
         (business_id, id, agent_actor_id, issued_by_person_id, issued_by_actor_id, purpose,
          scope, credential_hash, credential_scheme, credential_key_id, expires_at)
       values ($1, $2, $3, $4, $5, 'a reporting agent', array['task:read'], repeat('a', 64),
               'hmac-sha256-v1', 'test/written-once@1', now() + interval '30 days')`,
      [business, id, agent, person.personId, person.actorId],
    );

    await asApp(
      `update public.agent_credentials
          set revoked_at = timestamptz '2000-01-01 00:00:00+00', revoked_by_actor_id = $2
        where id = $1`,
      [id, person.actorId],
    );

    const [row] = await db.admin.execute<{ readonly recent: boolean }>(
      `select revoked_at > now() - interval '5 minutes' as recent
         from public.agent_credentials where id = $1`,
      [id],
    );
    expect(row).toStrictEqual({ recent: true });
  });
});
