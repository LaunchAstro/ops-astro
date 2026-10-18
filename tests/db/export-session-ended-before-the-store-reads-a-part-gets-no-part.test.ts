// SPDX-License-Identifier: AGPL-3.0-only
//
// #742: the operator's session ends after the export's last gate ask for a
// part and before the store runs that part's read (the route's container
// start and connect). The store cannot see the session, so it still answers
// that read; what it answers must be of no use without a later release. The
// export then delivers no part: nothing printed after the session ended holds
// a stored part's bytes, the store writes no part-read receipt after it, and
// no archive file is kept.

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
} from './backup-identity.fixture.ts';
import { drillModule, scratch as carriedScratch } from './backup-carried.fixture.ts';
import type { FreshDatabase } from '../support/fresh-database.ts';

let db: FreshDatabase;
let business = '';
let personId = '';

const partReceipts = async (): Promise<number> =>
  (
    await store.admin.execute<{ n: number }>(
      "select count(*)::int as n from backups.receipts where action = 'backup read' and part is not null",
    )
  )[0]?.n ?? 0;

/** One sealed archive in the store, with both installations agreeing on its operator: its parts' hex. */
async function plantedArchive(): Promise<string[]> {
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
  return (
    await store.admin.execute<{ hex: string }>(
      "select encode(chunk, 'hex') as hex from backups.archive_parts",
    )
  ).map((row) => row.hex);
}

/** The operator's environment, signed in under a session of its own. */
async function signedIn(sessionId: string): Promise<Record<string, string>> {
  return environment(marks(manager(false)), process.env['PATH'] ?? '', {
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
}

/**
 * The store's route, ending the session once it has taken the first part's
 * read whole (so every ask made as it is taken has answered) and before the
 * store runs it; it keeps every line handed out from then on.
 */
function endingAtThePartRead(env: Record<string, string>, sessionId: string) {
  const watched: { receiptsAtEnd?: number; handed: string[] } = { handed: [] };
  const keep = (line: string): string => {
    if (watched.receiptsAtEnd !== undefined) watched.handed.push(line);
    return line;
  };
  const reach: Reach = async (url, script, onLine) => {
    let text = '';
    if (typeof script === 'string') text = script;
    else for await (const piece of script) text += piece;
    if (watched.receiptsAtEnd === undefined && text.includes('backups.read_part(')) {
      await db.admin.execute('insert into ops.ended_provider_sessions (session_id) values ($1)', [
        sessionId,
      ]);
      expect(await requireOperatingOperator(env)).toMatchObject({ ok: false });
      watched.receiptsAtEnd = await partReceipts();
    }
    return keep(await hostReach(url, text, onLine && ((line: string) => onLine(keep(line)))));
  };
  return { reach, watched };
}

describe.skipIf(serverUrl === undefined)(
  'an export whose session ends before a part is read',
  () => {
    operatorOnlyHooks((state) => {
      db = state.db;
      business = state.alphaBusiness;
      personId = state.operatorPerson;
    });
    backupStoreHooks();
    afterAll(() => rmSync(scratch, { recursive: true, force: true }));
    afterAll(() => rmSync(carriedScratch, { recursive: true, force: true }));

    it('gets no part: nothing it is handed after the session ends holds a stored part', async () => {
      const stored = await plantedArchive();
      const sessionId = randomUUID();
      const env = await signedIn(sessionId);
      const gate = await requireOperatingOperator(env);
      if (!gate.ok) throw new Error('the made-up operator was not admitted');
      const { reach, watched } = endingAtThePartRead(env, sessionId);
      const file = join(mkdtempSync(join(scratch, 'ended-export-')), 'archive.sealed');
      const { exportArchive } = await drillModule();
      const [outcome] = await Promise.allSettled([
        exportArchive({ gate, storeUrl: operatorLogin.url, file, reach }),
      ]);

      expect(
        watched.receiptsAtEnd,
        'the session ended as the first part was asked for',
      ).toBeDefined();
      const handed = watched.handed.join('\n');
      expect({
        status: outcome?.status,
        archiveKept: existsSync(file),
        partReceiptsAfterEnd: (await partReceipts()) - (watched.receiptsAtEnd ?? 0),
        storedPartsHandedOut: stored.filter((hex) => handed.includes(hex)).length,
      }).toEqual({
        status: 'rejected',
        archiveKept: false,
        partReceiptsAfterEnd: 0,
        storedPartsHandedOut: 0,
      });
    });
  },
);
