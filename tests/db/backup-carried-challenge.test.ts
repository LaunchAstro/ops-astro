// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3e: a carried drill passes only with the restore challenge a restore of
// that very archive reads back (REV158K criterion 13, REV158S2 criterion 13).
// No challenge, a challenge that is not the one the job wrote, and a read of
// one of two archives taken in one transaction offered for the other are each
// refused, and the store records nothing. The shared parts are
// backup-carried.fixture.ts.
//
// S0-3 (S0-3e). The shared fixture is backup-identity.fixture.ts.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  serverUrl,
  BACKUP,
  RESTORE,
  keys,
  asRole,
  attempt,
  store,
  backupLogin,
  restoreLogin,
  addArchive,
  backupStoreHooks,
  hostReach,
  seal,
} from './backup-identity.fixture.ts';
import {
  carriedBack,
  carriedReceipt,
  copied,
  drillModule,
  drills,
  exportedFile,
  gateOf,
  operator,
  pendingReceipt,
  record,
  scratch,
  sha,
  type Receipt,
} from './backup-carried.fixture.ts';

let receipt: Receipt;

describe.skipIf(serverUrl === undefined)('the backup store', () => {
  backupStoreHooks();
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  describe('S0-3 carried archive', () => {
    beforeAll(async () => {
      receipt = await carriedReceipt();
    }, 120_000);
    challengeCases();
  });
});

function challengeCases() {
  challengeCases1();

  challengeCases2();
}

function challengeCases1() {
  it('a pending receipt with its archive but no restore challenge is refused, and the store records nothing', async () => {
    await expect(record(operator, carriedBack(receipt), copied(exportedFile()))).rejects.toThrow(
      /no restore challenge/u,
    );
    expect(await drills()).toStrictEqual([]);
  });

  it('a pending receipt with a restore challenge that is not the one the job wrote is refused by the store', async () => {
    const copy = copied(exportedFile());
    writeFileSync(`${copy}.challenge`, `${randomBytes(32).toString('hex')}\n`);
    await expect(record(operator, carriedBack(receipt), copy)).rejects.toThrow(
      /did not take the receipt/u,
    );
    expect(await drills()).toStrictEqual([]);
  });
}

function challengeCases2() {
  it('a read of one of two archives taken in one transaction never attests the other, even with its own digest and challenge', async () => {
    const before = (await drills()).length;
    const { sealArchive } = await seal();
    const challenges = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
    const bodies = ['-- one\n', '-- two\n'].map((dump) =>
      sealArchive(Buffer.from(dump), keys.publicKey),
    );
    const job = await asRole(backupLogin.url, BACKUP);
    try {
      await job.query('begin');
      for (const [i, body] of bodies.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- one archive after the other, in one transaction
        await addArchive(job, body, true, sha(challenges[i] ?? ''));
      }
      await job.query('commit');
    } finally {
      await job.end();
    }
    const reader = await asRole(restoreLogin.url, RESTORE);
    try {
      const { rows } = await reader.query<{ id: string; taken_at: Date }>(
        'select id::text, taken_at from backups.read_latest()',
      );
      const [read] = rows;
      const [unread] = [
        ...(await store.admin.execute<{ id: string; sha256: string }>(
          `select id::text, sha256 from backups.archives where id <> '${read?.id}'
             and taken_at = (select taken_at from backups.archives where id = '${read?.id}')`,
        )),
      ];
      expect(unread).toBeDefined();
      const index = bodies.findIndex((body) => sha(body) === unread?.sha256);
      // The other archive: its own digest and the challenge its dump carried.
      expect(index).toBeGreaterThanOrEqual(0);
      const call =
        'select backups.record_carried_drill($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)';
      const args = ['passed', null, operator, read?.taken_at, 17, 17, 17, 12, { fetch: 1 }];
      const attempted = [...args, unread?.sha256, challenges[index], unread?.id];
      expect(await attempt(reader, call, attempted)).toBe('42501');
    } finally {
      await reader.end();
    }
    expect(await drills()).toHaveLength(before);
  });

  it('Sol proof, criterion 13: decrypting an export without restoring it cannot produce a passed drill', async () => {
    const before = (await drills()).length;
    const challenge = randomBytes(32).toString('hex');
    const body = (await seal()).sealArchive(
      Buffer.from(`restore challenge ${challenge}\n`),
      keys.publicKey,
    );
    const job = await asRole(backupLogin.url, BACKUP);
    try {
      await addArchive(job, body, false, sha(challenge));
    } finally {
      await job.end();
    }
    const file = join(mkdtempSync(join(scratch, 'sol-decrypt-')), 'archive.sealed');
    await (
      await drillModule()
    ).exportArchive({
      gate: gateOf(operator),
      storeUrl: restoreLogin.url,
      file,
      reach: hostReach,
    });
    const plaintext = (await seal()).openArchive(readFileSync(file), keys.privateKey).toString();
    const extracted = /restore challenge ([0-9a-f]{64})/u.exec(plaintext)?.[1];
    expect(extracted).toBe(challenge);
    writeFileSync(`${file}.challenge`, `${extracted}\n`, { mode: 0o600 });
    const facts = JSON.parse(readFileSync(`${file}.json`, 'utf8')) as { takenAt: string };
    await expect(
      record(operator, carriedBack(pendingReceipt(facts.takenAt)), file),
    ).rejects.toThrow();
    expect(await drills()).toHaveLength(before);
  });
}
