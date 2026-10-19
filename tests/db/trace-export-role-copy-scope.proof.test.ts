// SPDX-License-Identifier: AGPL-3.0-only
// The second-model check's proof, kept as it was written, inside the database
// suite's skip: the trace export's login reads and registers only the
// diagnostic-trace copies, never an outbound prompt's, and stays out of
// another business and the client, person and credential tables.
/* oxlint-disable no-await-in-loop, max-lines-per-function */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asTraceRole } from '../../apps/trace-export/main.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('the trace login and copy classes', () => {
  let db: FreshDatabase;
  let login: Database;
  let own: string;
  let other: string;
  const copyKey = `call:${randomUUID()}`;
  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'trace_scope_proof' });
    own = await insertBusiness(db.app, 'trace-own');
    other = await insertBusiness(db.app, 'trace-other');
    await db.admin.execute(`grant ops_astro_trace to "${db.restrictedRole}"`);
    login = connect(db.restrictedUrl);
    for (const business of [own, other])
      await db.admin.execute(
        `insert into public.copy_registrations (business_id,id,copy_class,copy_key,invalidation_trigger,retention_class) values ($1,$2,'outbound_prompt',$3,'call_ended','transient')`,
        [business, randomUUID(), copyKey],
      );
  });
  afterAll(async () => {
    await login?.close();
    await db?.drop();
  });
  it('the trace-only login cannot read outbound-prompt copy rows', async () => {
    const txdb = asTraceRole(login);
    const found = await txdb.withBusiness(
      own,
      async (tx) =>
        await tx.query(
          `select business_id,copy_class,copy_key from public.copy_registrations where copy_class='outbound_prompt'`,
        ),
    );
    expect(found).toEqual([]);
  });
  it('the trace-only login cannot register an outbound-prompt copy', async () => {
    await expect(
      asTraceRole(login).withBusiness(
        own,
        async (tx) =>
          await tx.query(
            `insert into public.copy_registrations (business_id,id,copy_class,copy_key,invalidation_trigger,retention_class) values ($1,$2,'outbound_prompt',$3,'call_ended','transient')`,
            [own, randomUUID(), `call:${randomUUID()}`],
          ),
      ),
    ).rejects.toBeDefined();
  });
  it('business, client and person separation stays closed to the trace login', async () => {
    const txdb = asTraceRole(login);
    expect(
      await txdb.withBusiness(
        own,
        async (tx) =>
          await tx.query(
            `select business_id,copy_class,copy_key from public.copy_registrations where business_id=$1`,
            [other],
          ),
      ),
    ).toEqual([]);
    for (const table of [
      'clients',
      'people',
      'person_identifiers',
      'logins',
      'records',
      'custody_secrets',
    ]) {
      await expect(
        txdb.withBusiness(own, async (tx) => await tx.query(`select * from public.${table}`)),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });
});
