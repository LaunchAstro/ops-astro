// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { requireOperatingOperator } from '../../scripts/ops/operator.ts';
import { signBearer } from '../support/sign-in.ts';
import { environment, ISSUER, operatorOnlyHooks, subjects } from '../ci/operator-only.fixture.ts';
import { manager, marks, scratch } from '../ci/operator-only-commands.fixture.ts';
import {
  addArchive,
  asRole,
  BACKUP,
  backupLogin,
  backupStoreHooks,
  hostReach,
  keys,
  operatorLogin,
  seal,
  serverUrl,
  store,
  type Reach,
} from '../db/backup-identity.fixture.ts';
import { drillModule, scratch as carriedScratch } from '../db/backup-carried.fixture.ts';
import type { FreshDatabase } from '../support/fresh-database.ts';

let db: FreshDatabase;
let business = '';
let personId = '';
describe.skipIf(serverUrl === undefined)('OW-063 export revocation', () => {
  operatorOnlyHooks((state) => {
    db = state.db;
    business = state.alphaBusiness;
    personId = state.operatorPerson;
  });
  backupStoreHooks();
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  afterAll(() => rmSync(carriedScratch, { recursive: true, force: true }));

  it('Sol proof, criterion 5: an ended session between the gate check and the store read prevents export', async () => {
    // Match the two real installations, including the store's appointed person.
    await db.app.withBusiness(business, (tx) =>
      tx.query("update public.businesses set key = 'made-up' where id = $1", [business]),
    );
    await store.admin.execute('update backups.appointed set person = $1 where login = $2', [
      personId,
      operatorLogin.name,
    ]);
    const body = (await seal()).sealArchive(Buffer.from('-- made-up archive\n'), keys.publicKey);
    const job = await asRole(backupLogin.url, BACKUP);
    try {
      await addArchive(job, body);
    } finally {
      await job.end();
    }
    const at = marks(manager(false));
    const sessionId = randomUUID();
    const env = environment(at, process.env['PATH'] ?? '', {
      OPS_ASTRO_BUSINESS: 'made-up',
      OPS_ASTRO_TOKEN: await signBearer({
        sub: subjects.operator,
        iss: ISSUER,
        aud: 'authenticated',
        role: 'authenticated',
        session_id: sessionId,
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    });
    const gate = await requireOperatingOperator(env);
    expect(gate.ok).toBe(true);
    if (!gate.ok) throw new Error('fixture operator was not admitted');
    let ended = false;
    const reach: Reach = async (url, script, onLine) => {
      if (onLine !== undefined) {
        await db.admin.execute('insert into ops.ended_provider_sessions (session_id) values ($1)', [
          sessionId,
        ]);
        expect(await requireOperatingOperator(env)).toMatchObject({ ok: false });
        ended = true;
      }
      return await hostReach(url, script, onLine);
    };
    const file = join(mkdtempSync(join(scratch, 'revoked-export-')), 'archive.sealed');
    const { exportArchive } = await drillModule();
    const outcomes = await Promise.allSettled([
      exportArchive({ gate, storeUrl: operatorLogin.url, file, reach }),
    ]);
    expect(ended).toBe(true);
    expect({ archiveExported: existsSync(file), status: outcomes[0]?.status }).toEqual({
      archiveExported: false,
      status: 'rejected',
    });
  });
});
