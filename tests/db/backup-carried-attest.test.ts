// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3e: a passed drill is the appointed operator's own attestation (ticket
// S0-3 lines 13, 39 and 66; ORCH-DECISION 22:06Z and 22:09Z). The store takes
// a carried pass only through the store login the installation appointed as
// that person, in the operating business, for the very archive that login
// read, with its whole digest. Any value in a dump is readable by the key
// holder without a restore, so no such value is asked for. A login the
// installation did not appoint (the restore identity alone) records a failed
// drill and never a pass. The shared parts are backup-carried.fixture.ts.
//
// S0-3 (S0-3e). The shared fixture is backup-identity.fixture.ts.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  serverUrl,
  BACKUP,
  RESTORE,
  keys,
  asRole,
  attempt,
  backupLogin,
  restoreLogin,
  operatorLogin,
  OPERATING_BUSINESS,
  addArchive,
  backupStoreHooks,
  hostReach,
  seal,
  store,
} from './backup-identity.fixture.ts';
import {
  carriedBack,
  drillModule,
  drills,
  gateOf,
  operator,
  pendingReceipt,
  record,
  scratch,
  sha,
} from './backup-carried.fixture.ts';

const CALL =
  'select backups.record_carried_drill($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)';

/** A new archive of `dump` in the store, exported through `storeUrl`; answers the file and its facts. */
async function exported(
  dump: string,
  storeUrl: string,
): Promise<{ file: string; takenAt: string; sha256: string; archiveId: string }> {
  const job = await asRole(backupLogin.url, BACKUP);
  try {
    await addArchive(job, (await seal()).sealArchive(Buffer.from(dump), keys.publicKey));
  } finally {
    await job.end();
  }
  const file = join(mkdtempSync(join(scratch, 'attest-')), 'archive.sealed');
  await (
    await drillModule()
  ).exportArchive({ gate: gateOf(operator), storeUrl, file, reach: hostReach });
  const facts = JSON.parse(readFileSync(`${file}.json`, 'utf8')) as {
    takenAt: string;
    sha256: string;
    archiveId: string;
  };
  return { file, ...facts };
}

/** The store call's arguments for a carried receipt of `outcome` by `person` in `business`. */
const argsFor = (
  outcome: string,
  person: string,
  held: { takenAt: string; sha256: string; archiveId: string },
  business: string = OPERATING_BUSINESS,
): unknown[] => [
  outcome,
  outcome === 'passed' ? null : 'restore',
  person,
  held.takenAt,
  17,
  outcome === 'passed' ? 17 : null,
  17,
  outcome === 'passed' ? 12 : null,
  { fetch: 1 },
  held.sha256,
  held.archiveId,
  business,
];

describe.skipIf(serverUrl === undefined)('the backup store', () => {
  backupStoreHooks();
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  describe('S0-3 carried archive, the operator attests', () => {
    attestCases1();

    attestCases2();

    attestCases3();
    attestCases4();
  });
});

function attestCases1() {
  // Sol's REV158K2 criterion 13 proof, adapted from "without restoring it" to
  // "without the verified operator" (ORCH-DECISION 22:06Z): the export is
  // decrypted and never restored, and its pending receipt, of the exact
  // accepted shape, is brought back through the restore identity alone (the
  // export itself is the appointed login's: the store refuses any other read).
  it('decrypting an export without restoring it cannot produce a passed drill without the verified operator', async () => {
    const before = (await drills()).length;
    const held = await exported(`-- ${randomUUID()}\n`, operatorLogin.url);
    const plaintext = (await seal()).openArchive(readFileSync(held.file), keys.privateKey);
    expect(plaintext.length).toBeGreaterThan(0);
    await expect(
      record(operator, carriedBack(pendingReceipt(held.takenAt)), held.file, restoreLogin.url),
    ).rejects.toThrow(/not the installation's appointed operator/u);
    expect(await drills()).toHaveLength(before);
  });

  it('the appointed login records no pass for another person, nor in another business, and the store records nothing', async () => {
    const before = (await drills()).length;
    const held = await exported('-- another\n', operatorLogin.url);
    const client = await asRole(operatorLogin.url, RESTORE);
    try {
      expect(await attempt(client, CALL, argsFor('passed', randomUUID(), held))).toBe('42501');
      expect(
        await attempt(client, CALL, argsFor('passed', operator, held, 'another-business')),
      ).toBe('42501');
      expect(await attempt(client, CALL, argsFor('passed', operator, held, null as never))).toBe(
        '42501',
      );
    } finally {
      await client.end();
    }
    expect(await drills()).toHaveLength(before);
  });
}

/** How many reads the store has logged. */
const reads = async (): Promise<number | undefined> =>
  (
    await store.admin.execute<{ n: number }>(
      "select count(*)::int as n from backups.receipts where action = 'backup read'",
    )
  )[0]?.n;

function attestCases3() {
  it('the restore identity alone reads no archive and records no carried drill; the appointed login records a failed one, and the store keeps who recorded which archive', async () => {
    const held = await exported('-- failed\n', operatorLogin.url);
    const alone = await asRole(restoreLogin.url, RESTORE);
    try {
      const before = await reads();
      const latest = 'select id from backups.read_latest($1, $2)';
      expect(await attempt(alone, latest, [operator, OPERATING_BUSINESS])).toBe('42501');
      expect(await reads()).toBe(before);
      expect(await attempt(alone, CALL, argsFor('failed', operator, held))).toBe('42501');
    } finally {
      await alone.end();
    }
    const client = await asRole(operatorLogin.url, RESTORE);
    try {
      await client.query(CALL, argsFor('failed', operator, held));
    } finally {
      await client.end();
    }
    const [row] = await store.admin.execute<Record<string, unknown>>(
      'select outcome, operator::text, actor, archive_id::text, business from backups.drills where archive_id = $1',
      [held.archiveId],
    );
    expect(row).toStrictEqual({
      outcome: 'failed',
      operator,
      actor: operatorLogin.name,
      archive_id: held.archiveId,
      business: OPERATING_BUSINESS,
    });
  });
}

function attestCases2() {
  it('a read of one of two archives taken in one transaction never attests the other, even by the appointed operator with its own digest', async () => {
    const before = (await drills()).length;
    const { sealArchive } = await seal();
    const bodies = ['-- one\n', '-- two\n'].map((dump) =>
      sealArchive(Buffer.from(dump), keys.publicKey),
    );
    const job = await asRole(backupLogin.url, BACKUP);
    try {
      await job.query('begin');
      for (const body of bodies) {
        // oxlint-disable-next-line no-await-in-loop -- one archive after the other, in one transaction
        await addArchive(job, body, true);
      }
      await job.query('commit');
    } finally {
      await job.end();
    }
    const reader = await asRole(operatorLogin.url, RESTORE);
    try {
      const { rows } = await reader.query<{ id: string; taken_at: Date; sha256: string }>(
        'select id::text, taken_at, sha256 from backups.read_latest($1, $2)',
        [operator, OPERATING_BUSINESS],
      );
      const [read] = rows;
      const [unread] = [
        ...(await store.admin.execute<{ id: string; sha256: string }>(
          `select id::text, sha256 from backups.archives
             where id <> $1 and taken_at = (select taken_at from backups.archives where id = $1)`,
          [read?.id],
        )),
      ];
      expect(unread).toBeDefined();
      expect(bodies.some((body) => sha(body) === unread?.sha256)).toBe(true);
      const takenAt = read?.taken_at.toISOString() ?? '';
      const other = { takenAt, sha256: unread?.sha256 ?? '', archiveId: unread?.id ?? '' };
      expect(await attempt(reader, CALL, argsFor('passed', operator, other))).toBe('42501');
      // The archive it read, with its own digest, is taken: the refusal above is the binding's.
      const own = { takenAt, sha256: read?.sha256 ?? '', archiveId: read?.id ?? '' };
      expect(await attempt(reader, CALL, argsFor('passed', operator, own))).toBe('ok');
    } finally {
      await reader.end();
    }
    expect(await drills()).toHaveLength(before);
  });
}

// Sol's REV158K3 criterion 13 proof, retitled by what it proves; its body is Sol's.
function attestCases4() {
  it('a carried receipt cannot attest another exported archive with the same timestamp', async () => {
    const before = (await drills()).length;
    const first = await exported('-- first archive\n', operatorLogin.url);
    await store.admin.execute(
      "update backups.archives set taken_at = date_trunc('milliseconds', taken_at) where id = $1",
      [first.archiveId],
    );
    const writer = await asRole(backupLogin.url, BACKUP);
    try {
      await addArchive(
        writer,
        (await seal()).sealArchive(Buffer.from('-- second archive\n'), keys.publicKey),
      );
    } finally {
      await writer.end();
    }
    const [secondRow] = await store.admin.execute<{ id: string }>(
      'select id::text from backups.archives where id <> $1 order by taken_at desc, id desc limit 1',
      [first.archiveId],
    );
    expect(secondRow).toBeDefined();
    await store.admin.execute(
      "update backups.archives set taken_at = (select taken_at from backups.archives where id = $1) + interval '500 microseconds' where id = $2",
      [first.archiveId, secondRow?.id],
    );
    const secondFile = join(mkdtempSync(join(scratch, 'sol-same-time-')), 'archive.sealed');
    await (
      await drillModule()
    ).exportArchive({
      gate: gateOf(operator),
      storeUrl: operatorLogin.url,
      file: secondFile,
      reach: hostReach,
    });
    const second = JSON.parse(readFileSync(`${secondFile}.json`, 'utf8')) as {
      archiveId: string;
      takenAt: string;
    };
    expect(second.archiveId).toBe(secondRow?.id);
    expect(second.takenAt).toBe(first.takenAt);
    await expect(
      record(operator, carriedBack(pendingReceipt(first.takenAt)), secondFile),
    ).rejects.toThrow();
    expect(await drills()).toHaveLength(before);
  });
}
